import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the controller so we can drive onPauseChange from the test.
const pauseListeners = new Set<(p: boolean) => void>();
const chunkStateListeners = new Set<(s: string) => void>();
let lastController: { pause: () => void; resume: () => void; loadOlderChunk: () => Promise<void>; onScroll: (s: { atBottom: boolean; nearTop: boolean }) => void } | null = null;
vi.mock('../lib/terminalController.js', () => {
  return {
    TerminalController: vi.fn().mockImplementation(() => {
      const inst = {
        pause: vi.fn(),
        resume: vi.fn().mockResolvedValue(undefined),
        loadOlderChunk: vi.fn().mockResolvedValue(undefined),
        setInteractive: vi.fn(),
        resize: vi.fn(),
        requestRedraw: vi.fn(),
        isReady: () => true,
        onReady: vi.fn(),
        onPauseChange: (cb: (p: boolean) => void) => { pauseListeners.add(cb); return () => pauseListeners.delete(cb); },
        onChunkStateChange: (cb: (s: string) => void) => { chunkStateListeners.add(cb); return () => chunkStateListeners.delete(cb); },
        onRebuildingChange: (_cb: (r: boolean) => void) => () => { /* noop */ },
        onScroll: vi.fn(),
        dispose: vi.fn(),
      };
      lastController = inst;
      return inst;
    }),
  };
});

// Mock xterm.
const oscHandlers = new Map<number, (data: string) => boolean>();

vi.mock('@xterm/xterm', () => {
  class FakeTerm {
    cols = 120; rows = 40;
    options: Record<string, unknown> = {};
    buffer = { active: { baseY: 100, viewportY: 100 } };
    parser = {
      registerOscHandler: vi.fn((code: number, handler: (data: string) => boolean) => {
        oscHandlers.set(code, handler);
        return { dispose: vi.fn() };
      }),
    };
    open() {}
    loadAddon() {}
    onScroll(cb: () => void) { (FakeTerm as unknown as { __scrollCbs: Array<() => void> }).__scrollCbs = [cb]; return { dispose() {} }; }
    dispose() {}
    focus() {}
    write() {}
    reset() {}
  }
  return { Terminal: FakeTerm };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { loadAddon() {} fit() {} } }));

// Import AFTER mocks.
import { Terminal } from './Terminal.js';

describe('Terminal', () => {
  beforeEach(() => oscHandlers.clear());

  it('renders without crashing and has no "Load full history" button', () => {
    render(<Terminal runId={1} interactive={false} />);
    expect(screen.queryByText(/Load full history/i)).toBeNull();
  });

  it('shows the pause banner with Resume stream when onPauseChange(true) fires', () => {
    render(<Terminal runId={1} interactive={false} />);
    expect(screen.queryByText(/Stream paused/i)).toBeNull();
    act(() => { for (const cb of pauseListeners) cb(true); });
    expect(screen.getByText(/Stream paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume stream/i })).toBeInTheDocument();
  });

  it('clicking Resume stream calls controller.resume()', async () => {
    render(<Terminal runId={1} interactive={false} />);
    act(() => { for (const cb of pauseListeners) cb(true); });
    await userEvent.click(screen.getByRole('button', { name: /Resume stream/i }));
    expect(lastController?.resume).toHaveBeenCalled();
  });

  it('shows Loading older history strip when chunk state is loading and user is paused', () => {
    render(<Terminal runId={1} interactive={false} />);
    act(() => { for (const cb of pauseListeners) cb(true); });
    act(() => { for (const cb of chunkStateListeners) cb('loading'); });
    expect(screen.getByText(/Loading older history/i)).toBeInTheDocument();
  });

  it('shows Failed to load older history with Retry on error', async () => {
    render(<Terminal runId={1} interactive={false} />);
    act(() => { for (const cb of pauseListeners) cb(true); });
    act(() => { for (const cb of chunkStateListeners) cb('error'); });
    expect(screen.getByText(/Failed to load older history/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/i });
    await userEvent.click(retry);
    expect(lastController?.loadOlderChunk).toHaveBeenCalled();
  });

  it('registers an OSC 52 handler on mount', () => {
    render(<Terminal runId={1} interactive={false} />);
    expect(oscHandlers.has(52)).toBe(true);
  });

  it('OSC 52 handler decodes UTF-8 base64 and writes to navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    render(<Terminal runId={2} interactive={false} />);
    const handler = oscHandlers.get(52)!;

    // UTF-8 encode "héllo" then base64 it (matches what the container shim does)
    const bytes = new TextEncoder().encode('héllo');
    const b64 = btoa(String.fromCharCode(...bytes));
    handler(`c;${b64}`);

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('héllo');
    });
  });

  it('OSC 52 handler ignores read requests (? payload) and returns true', () => {
    render(<Terminal runId={3} interactive={false} />);
    const handler = oscHandlers.get(52)!;
    const result = handler('c;?');
    expect(result).toBe(true);
  });

  it('OSC 52 handler ignores malformed base64 without throwing', () => {
    render(<Terminal runId={4} interactive={false} />);
    const handler = oscHandlers.get(52)!;
    expect(() => handler('c;!!!not-valid-base64!!!')).not.toThrow();
  });
});
