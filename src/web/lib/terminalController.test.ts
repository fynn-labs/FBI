import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellHandle } from './ws.js';
import type { RunWsSnapshotMessage } from '@shared/types.js';

// Mock shellRegistry before importing the controller.
const acquiredShells = new Map<number, ShellHandle>();
vi.mock('./shellRegistry.js', () => ({
  acquireShell: (runId: number) => acquiredShells.get(runId),
  releaseShell: vi.fn(),
  getLastSnapshot: (_runId: number) => null,
}));

// Mock usageBus publishers so the controller can route typed events.
const usagePublishes: Array<[number, unknown]> = [];
vi.mock('../features/runs/usageBus.js', () => ({
  publishUsage: (runId: number, s: unknown) => { usagePublishes.push([runId, s]); },
  publishState: vi.fn(),
  publishTitle: vi.fn(),
  publishFiles: vi.fn(),
}));

import { TerminalController } from './terminalController.js';

function makeStubShell(opts: { openState?: 'open' | 'pending' } = {}): ShellHandle & {
  _bytes: Array<(d: Uint8Array) => void>;
  _snap: Array<(s: RunWsSnapshotMessage) => void>;
  _events: Array<(m: { type: string }) => void>;
  _fireOpen: () => void;
  sentHello: Array<{ cols: number; rows: number }>;
  resizes: Array<{ cols: number; rows: number }>;
  sent: Uint8Array[];
} {
  const bytes: Array<(d: Uint8Array) => void> = [];
  const snap: Array<(s: RunWsSnapshotMessage) => void> = [];
  const events: Array<(m: { type: string }) => void> = [];
  const openCbs: Array<() => void> = [];
  let open = opts.openState === 'open';
  const stub = {
    _bytes: bytes,
    _snap: snap,
    _events: events,
    _fireOpen: () => {
      open = true;
      for (const cb of openCbs.splice(0)) cb();
    },
    sentHello: [] as Array<{ cols: number; rows: number }>,
    resizes: [] as Array<{ cols: number; rows: number }>,
    sent: [] as Uint8Array[],
    onBytes: vi.fn((cb: (d: Uint8Array) => void) => { bytes.push(cb); return () => { const i = bytes.indexOf(cb); if (i !== -1) bytes.splice(i, 1); }; }),
    onSnapshot: vi.fn((cb: (s: RunWsSnapshotMessage) => void) => { snap.push(cb); return () => { const i = snap.indexOf(cb); if (i !== -1) snap.splice(i, 1); }; }),
    onTypedEvent: vi.fn(<T extends { type: string }>(cb: (m: T) => void) => { const w = (m: { type: string }) => cb(m as T); events.push(w); return () => { const i = events.indexOf(w); if (i !== -1) events.splice(i, 1); }; }),
    onOpen: vi.fn((cb: () => void) => {
      if (open) { queueMicrotask(cb); return () => {}; }
      openCbs.push(cb);
      return () => { const i = openCbs.indexOf(cb); if (i !== -1) openCbs.splice(i, 1); };
    }),
    send: vi.fn((d: Uint8Array) => { stub.sent.push(d); }),
    resize: vi.fn((cols: number, rows: number) => { stub.resizes.push({ cols, rows }); }),
    sendHello: vi.fn((cols: number, rows: number) => { stub.sentHello.push({ cols, rows }); }),
    close: vi.fn(),
  };
  return stub;
}

function makeFakeXterm() {
  type DataCb = (d: string) => void;
  const dataCbs: DataCb[] = [];
  const writes: Array<string | Uint8Array> = [];
  return {
    cols: 120,
    rows: 40,
    writes,
    dataCbs,
    options: {} as Record<string, unknown>,
    write: vi.fn((data: string | Uint8Array, cb?: () => void) => {
      writes.push(data);
      if (cb) cb();
    }),
    reset: vi.fn(() => { writes.push('__RESET__'); }),
    focus: vi.fn(),
    onData: vi.fn((cb: DataCb) => {
      dataCbs.push(cb);
      return { dispose: () => { const i = dataCbs.indexOf(cb); if (i !== -1) dataCbs.splice(i, 1); } };
    }),
    dispose: vi.fn(),
  };
}

beforeEach(() => {
  acquiredShells.clear();
  usagePublishes.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TerminalController', () => {
  it('subscribes to bytes/snapshot/events and sends hello on WS open', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(1, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');

    const c = new TerminalController(1, term as unknown as import('@xterm/xterm').Terminal, host);
    await Promise.resolve();

    expect(shell.onBytes).toHaveBeenCalledTimes(1);
    expect(shell.onSnapshot).toHaveBeenCalledTimes(1);
    expect(shell.onTypedEvent).toHaveBeenCalledTimes(1);
    expect(shell.sentHello).toEqual([{ cols: 120, rows: 40 }]);

    c.dispose();
  });

  it('writes live bytes straight to the xterm (no rAF queue)', () => {
    const shell = makeStubShell();
    acquiredShells.set(2, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    new TerminalController(2, term as unknown as import('@xterm/xterm').Terminal, host);

    const payload = new TextEncoder().encode('live');
    for (const cb of shell._bytes) cb(payload);

    expect(term.write).toHaveBeenCalledWith(payload);
  });

  it('resets + writes on snapshot arrival', () => {
    const shell = makeStubShell();
    acquiredShells.set(3, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    new TerminalController(3, term as unknown as import('@xterm/xterm').Terminal, host);

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'ANSI_SNAP', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.writes).toEqual(['__RESET__', 'ANSI_SNAP']);
  });

  it('schedules a cursor-redraw nudge on every snapshot (initial AND reconnect)', async () => {
    vi.useFakeTimers();
    try {
      const shell = makeStubShell();
      acquiredShells.set(30, shell);
      const term = makeFakeXterm();
      const host = document.createElement('div');
      new TerminalController(30, term as unknown as import('@xterm/xterm').Terminal, host);
      shell.resizes.length = 0;

      const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'A', cols: 120, rows: 40 };

      // First snapshot.
      for (const cb of shell._snap) cb(snap);
      vi.advanceTimersByTime(800);
      // requestRedraw fires two resizes: rows+1 then rows.
      vi.advanceTimersByTime(40);
      expect(shell.resizes).toEqual([
        { cols: 120, rows: 41 },
        { cols: 120, rows: 40 },
      ]);

      // Reconnect-served snapshot must also trigger a fresh redraw nudge.
      shell.resizes.length = 0;
      for (const cb of shell._snap) cb(snap);
      vi.advanceTimersByTime(800);
      vi.advanceTimersByTime(40);
      expect(shell.resizes).toEqual([
        { cols: 120, rows: 41 },
        { cols: 120, rows: 40 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setInteractive(true) wires term.onData and focuses; (false) detaches', () => {
    const shell = makeStubShell();
    acquiredShells.set(4, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(4, term as unknown as import('@xterm/xterm').Terminal, host);

    c.setInteractive(true);
    expect(term.onData).toHaveBeenCalledTimes(1);
    expect(term.focus).toHaveBeenCalledTimes(1);

    for (const cb of term.dataCbs) cb('x');
    expect(shell.send).toHaveBeenCalledTimes(1);

    c.setInteractive(false);
    expect(term.dataCbs).toHaveLength(0);
  });

  it('resumeLive focuses the live xterm even when no history is active', () => {
    const shell = makeStubShell();
    acquiredShells.set(5, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(5, term as unknown as import('@xterm/xterm').Terminal, host);

    term.focus.mockClear();
    c.resumeLive();

    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it('dispose unsubscribes everything and releases the shell', async () => {
    const shell = makeStubShell();
    acquiredShells.set(6, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(6, term as unknown as import('@xterm/xterm').Terminal, host);

    const { releaseShell } = await import('./shellRegistry.js');

    c.dispose();

    const payload = new TextEncoder().encode('late');
    for (const cb of shell._bytes) cb(payload);
    expect(term.write).not.toHaveBeenCalledWith(payload);
    expect(releaseShell).toHaveBeenCalledWith(6);
  });

  it('forwards usage events through the usageBus', () => {
    const shell = makeStubShell();
    acquiredShells.set(7, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    new TerminalController(7, term as unknown as import('@xterm/xterm').Terminal, host);

    const snapshot = { messages_remaining: 99 };
    for (const cb of shell._events) cb({ type: 'usage', snapshot } as unknown as { type: string });
    expect(usagePublishes).toEqual([[7, snapshot]]);
  });

  it('requestRedraw perturbs rows and restores to force two SIGWINCHes', async () => {
    vi.useFakeTimers();
    try {
      const shell = makeStubShell();
      acquiredShells.set(10, shell);
      const term = makeFakeXterm();
      const host = document.createElement('div');
      const c = new TerminalController(10, term as unknown as import('@xterm/xterm').Terminal, host);
      shell.resizes.length = 0;

      c.requestRedraw();
      // First resize lands synchronously: rows+1.
      expect(shell.resizes).toEqual([{ cols: 120, rows: 41 }]);

      // Second resize lands on next setTimeout tick at current dims.
      vi.advanceTimersByTime(40);
      expect(shell.resizes).toEqual([
        { cols: 120, rows: 41 },
        { cols: 120, rows: 40 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onReady fires after 400ms of byte silence post-snapshot (not before)', async () => {
    vi.useFakeTimers();
    try {
      const shell = makeStubShell();
      acquiredShells.set(11, shell);
      const term = makeFakeXterm();
      const host = document.createElement('div');
      const c = new TerminalController(11, term as unknown as import('@xterm/xterm').Terminal, host);

      const readyCb = vi.fn();
      c.onReady(readyCb);

      const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'X', cols: 120, rows: 40 };
      for (const cb of shell._snap) cb(snap);
      // Snapshot parsed (write callback fires synchronously in the fake).
      // Ready should NOT have fired yet — we wait for byte silence.
      expect(readyCb).not.toHaveBeenCalled();

      // Simulate a byte arriving 300ms in; resets the silence timer.
      vi.advanceTimersByTime(300);
      for (const cb of shell._bytes) cb(new TextEncoder().encode('more'));
      expect(readyCb).not.toHaveBeenCalled();

      // 400ms after the LAST byte, ready fires.
      vi.advanceTimersByTime(400);
      expect(readyCb).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onReady fires via the 2s hard cap even if bytes keep flowing', () => {
    vi.useFakeTimers();
    try {
      const shell = makeStubShell();
      acquiredShells.set(12, shell);
      const term = makeFakeXterm();
      const host = document.createElement('div');
      const c = new TerminalController(12, term as unknown as import('@xterm/xterm').Terminal, host);

      const readyCb = vi.fn();
      c.onReady(readyCb);

      const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'X', cols: 120, rows: 40 };
      for (const cb of shell._snap) cb(snap);

      // Steady byte stream: 100ms cadence, never idle long enough for
      // the 400ms silence timer to fire.
      for (let t = 0; t < 2500; t += 100) {
        vi.advanceTimersByTime(100);
        for (const cb of shell._bytes) cb(new TextEncoder().encode('b'));
      }
      expect(readyCb).toHaveBeenCalledTimes(1); // via 2000ms cap
    } finally {
      vi.useRealTimers();
    }
  });
});
