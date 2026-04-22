import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JsonEditor } from './JsonEditor.js';

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange, theme }: { value: string; onChange?: (v: string) => void; theme?: unknown }) => (
    <textarea
      data-testid="codemirror"
      data-theme={theme ? 'dark' : 'light'}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
  oneDark: { name: 'oneDark' },
}));

vi.mock('@codemirror/lang-json', () => ({
  json: () => ({}),
}));

beforeEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('JsonEditor', () => {
  it('renders the label', () => {
    render(<JsonEditor label="My JSON Field" value="" onChange={() => {}} />);
    expect(screen.getByText('My JSON Field')).toBeInTheDocument();
  });

  it('shows no status indicator for empty value', () => {
    render(<JsonEditor label="JSON" value="" onChange={() => {}} />);
    expect(screen.queryByText(/valid json/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/✗/)).not.toBeInTheDocument();
  });

  it('shows valid indicator for valid JSON', () => {
    render(<JsonEditor label="JSON" value='{"image":"ubuntu:22.04"}' onChange={() => {}} />);
    expect(screen.getByText(/✓ valid json/i)).toBeInTheDocument();
  });

  it('shows error indicator for invalid JSON', () => {
    render(<JsonEditor label="JSON" value='{bad json' onChange={() => {}} />);
    expect(screen.getByText(/✗/)).toBeInTheDocument();
  });

  it('calls onChange when editor value changes', async () => {
    const onChange = vi.fn();
    render(<JsonEditor label="JSON" value="" onChange={onChange} />);
    await userEvent.type(screen.getByTestId('codemirror'), '{{');
    expect(onChange).toHaveBeenCalledWith('{');
  });

  it('renders without error when dark class is set on documentElement', () => {
    document.documentElement.classList.add('dark');
    render(<JsonEditor label="JSON" value='{}' onChange={() => {}} />);
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText(/✓ valid json/i)).toBeInTheDocument();
  });

  it('switches to dark theme via MutationObserver when dark class is added', async () => {
    render(<JsonEditor label="JSON" value="" onChange={() => {}} />);
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-theme', 'light');
    act(() => {
      document.documentElement.classList.add('dark');
    });
    await waitFor(() => {
      expect(screen.getByTestId('codemirror')).toHaveAttribute('data-theme', 'dark');
    });
    act(() => {
      document.documentElement.classList.remove('dark');
    });
  });
});
