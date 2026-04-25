import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneFocusProvider, usePaneFocus, usePaneRegistration, useFocusedPane } from './PaneFocusContext.js';
import { keymap } from './KeyMap.js';

beforeEach(() => { keymap._reset(); });

function Pane({ id, order, label }: { id: Parameters<typeof usePaneFocus>[0]; order: number; label: string }) {
  usePaneRegistration(id, order);
  const { isFocused, focus } = usePaneFocus(id);
  return <div data-testid={id} data-focused={String(isFocused)} onClick={focus}>{label}</div>;
}

function FocusDisplay() {
  const f = useFocusedPane();
  return <div data-testid="focused">{f ?? 'none'}</div>;
}

function App({ panes = ['projects-sidebar', 'runs-sidebar', 'run-terminal'] as const }) {
  return (
    <PaneFocusProvider>
      <FocusDisplay />
      {panes.map((id, i) => <Pane key={id} id={id} order={i} label={id} />)}
    </PaneFocusProvider>
  );
}

function fireKey(key: string): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
}

describe('PaneFocusContext', () => {
  it('starts with no pane focused', () => {
    render(<App />);
    expect(screen.getByTestId('focused').textContent).toBe('none');
    expect(screen.getByTestId('projects-sidebar').dataset.focused).toBe('false');
  });

  it('clicking a pane sets it as focused', async () => {
    render(<App />);
    await userEvent.click(screen.getByTestId('runs-sidebar'));
    expect(screen.getByTestId('focused').textContent).toBe('runs-sidebar');
    expect(screen.getByTestId('runs-sidebar').dataset.focused).toBe('true');
    expect(screen.getByTestId('projects-sidebar').dataset.focused).toBe('false');
  });

  it('ArrowRight from null focuses first registered pane', () => {
    render(<App />);
    fireKey('ArrowRight');
    expect(screen.getByTestId('focused').textContent).toBe('projects-sidebar');
  });

  it('ArrowRight advances to next horizontal pane', async () => {
    render(<App />);
    await userEvent.click(screen.getByTestId('projects-sidebar'));
    fireKey('ArrowRight');
    expect(screen.getByTestId('focused').textContent).toBe('runs-sidebar');
  });

  it('ArrowLeft retreats to previous horizontal pane', async () => {
    render(<App />);
    await userEvent.click(screen.getByTestId('runs-sidebar'));
    fireKey('ArrowLeft');
    expect(screen.getByTestId('focused').textContent).toBe('projects-sidebar');
  });

  it('ArrowRight clamps at last horizontal pane', async () => {
    render(<App />);
    await userEvent.click(screen.getByTestId('run-terminal'));
    fireKey('ArrowRight');
    expect(screen.getByTestId('focused').textContent).toBe('run-terminal');
  });

  it('ArrowDown from run-terminal sets run-bottom', async () => {
    render(<App panes={['run-terminal']} />);
    await userEvent.click(screen.getByTestId('run-terminal'));
    fireKey('ArrowDown');
    expect(screen.getByTestId('focused').textContent).toBe('run-bottom');
  });

  it('ArrowUp from run-bottom returns to run-terminal', async () => {
    render(<App panes={['run-terminal']} />);
    await userEvent.click(screen.getByTestId('run-terminal'));
    fireKey('ArrowDown');
    fireKey('ArrowUp');
    expect(screen.getByTestId('focused').textContent).toBe('run-terminal');
  });
});
