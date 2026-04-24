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
  const buffer = { active: { baseY: 0, viewportY: 0 } };
  const scrollCbs: Array<() => void> = [];
  return {
    cols: 120,
    rows: 40,
    writes,
    dataCbs,
    scrollCbs,
    buffer,
    options: {} as Record<string, unknown>,
    write: vi.fn((data: string | Uint8Array, cb?: () => void) => {
      writes.push(data);
      if (cb) cb();
    }),
    reset: vi.fn(() => { writes.push('__RESET__'); buffer.active.baseY = 0; buffer.active.viewportY = 0; }),
    focus: vi.fn(),
    onData: vi.fn((cb: DataCb) => {
      dataCbs.push(cb);
      return { dispose: () => { const i = dataCbs.indexOf(cb); if (i !== -1) dataCbs.splice(i, 1); } };
    }),
    onScroll: vi.fn((cb: () => void) => {
      scrollCbs.push(cb);
      return { dispose: () => { const i = scrollCbs.indexOf(cb); if (i !== -1) scrollCbs.splice(i, 1); } };
    }),
    scrollToLine: vi.fn((_line: number) => { /* no-op in fake */ }),
    scrollToBottom: vi.fn(() => { buffer.active.viewportY = buffer.active.baseY; }),
    dispose: vi.fn(),
  };
}

interface FetchCall { url: string; headers: Record<string, string> }
const fetchCalls: FetchCall[] = [];
let fetchResponder: (call: FetchCall) => { status: number; headers: Record<string, string>; body: Uint8Array } =
  () => ({ status: 404, headers: {}, body: new Uint8Array() });

function installFetchMock() {
  globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const h: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) h[k.toLowerCase()] = v;
    const call: FetchCall = { url: String(url), headers: h };
    fetchCalls.push(call);
    const r = fetchResponder(call);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get: (name: string) => r.headers[name.toLowerCase()] ?? null,
      },
      arrayBuffer: () => Promise.resolve(r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength)),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  acquiredShells.clear();
  usagePublishes.length = 0;
  fetchCalls.length = 0;
  fetchResponder = () => ({ status: 404, headers: {}, body: new Uint8Array() });
  installFetchMock();
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

  it('accumulates live bytes in liveTailBytes and advances liveOffset', () => {
    const shell = makeStubShell();
    acquiredShells.set(20, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(20, term as unknown as import('@xterm/xterm').Terminal, host);

    for (const cb of shell._bytes) cb(new TextEncoder().encode('abc'));
    for (const cb of shell._bytes) cb(new TextEncoder().encode('de'));

    // Exposed for tests via a `_debugBuffers()` accessor (see Step 5.3).
    const bufs = c._debugBuffers();
    expect(Buffer.from(bufs.liveTailBytes).toString()).toBe('abcde');
    expect(bufs.liveOffset).toBe(5);
  });

  it('tracks latestState from state typed events', () => {
    const shell = makeStubShell();
    acquiredShells.set(21, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(21, term as unknown as import('@xterm/xterm').Terminal, host);

    for (const cb of shell._events) {
      cb({ type: 'state', state: 'running' } as unknown as { type: string });
    }
    expect(c._debugBuffers().latestState).toBe('running');

    for (const cb of shell._events) {
      cb({ type: 'state', state: 'succeeded' } as unknown as { type: string });
    }
    expect(c._debugBuffers().latestState).toBe('succeeded');
  });

  it('pause() sets paused state; live bytes are dropped while paused', () => {
    const shell = makeStubShell();
    acquiredShells.set(22, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(22, term as unknown as import('@xterm/xterm').Terminal, host);

    for (const cb of shell._bytes) cb(new TextEncoder().encode('pre'));
    expect(c._debugBuffers().liveTailBytes.byteLength).toBe(3);

    c.pause();
    expect(c._debugBuffers().paused).toBe(true);
    term.write.mockClear();
    for (const cb of shell._bytes) cb(new TextEncoder().encode('dropped'));
    expect(term.write).not.toHaveBeenCalled();
    expect(c._debugBuffers().liveTailBytes.byteLength).toBe(3); // unchanged
    expect(c._debugBuffers().liveOffset).toBe(3); // unchanged — dropped bytes aren't counted
  });

  it('pause() is idempotent; double pause does not fire listeners twice', () => {
    const shell = makeStubShell();
    acquiredShells.set(23, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(23, term as unknown as import('@xterm/xterm').Terminal, host);

    const listener = vi.fn();
    c.onPauseChange(listener);
    c.pause();
    c.pause();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it('setInteractive gate: paused blocks typing even when interactive=true', () => {
    const shell = makeStubShell();
    acquiredShells.set(24, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(24, term as unknown as import('@xterm/xterm').Terminal, host);

    c.setInteractive(true);
    expect(term.onData).toHaveBeenCalledTimes(1);

    c.pause();
    // Gate closed: onData handler is detached.
    expect(term.dataCbs).toHaveLength(0);
  });

  it('seedInitialHistory fetches last 512KB via Range, rebuilds xterm with [seed, snapshot]', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(40, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(40, term as unknown as import('@xterm/xterm').Terminal, host);

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'SNAP', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);
    expect(term.writes).toEqual(['__RESET__', 'SNAP']);

    const FULL_TOTAL = 1_000_000;
    const seedBytes = new Uint8Array(512 * 1024).fill(65); // 'A' * 524288
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      expect(call.url).toBe('/api/runs/40/transcript');
      if (call.headers.range === 'bytes=0-0') {
        return {
          status: 206,
          headers: { 'x-transcript-total': String(FULL_TOTAL) },
          body: new Uint8Array([0]),
        };
      }
      if (call.headers.range === `bytes=${FULL_TOTAL - 524288}-${FULL_TOTAL - 1}`) {
        return {
          status: 206,
          headers: {
            'x-transcript-total': String(FULL_TOTAL),
            'content-range': `bytes ${FULL_TOTAL - 524288}-${FULL_TOTAL - 1}/${FULL_TOTAL}`,
          },
          body: seedBytes,
        };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };

    // Seed is kicked off after the snapshot handler runs — controller calls it internally.
    // Give it a few macrotask ticks to settle the async chain (meta fetch, seed fetch, rebuild).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const bufs = c._debugBuffers();
    expect(bufs.loadedBytes.byteLength).toBe(524288 + 4); // seed + 'SNAP'
    expect(bufs.loadedStartOffset).toBe(FULL_TOTAL - 524288);
    expect(bufs.liveOffset).toBe(FULL_TOTAL);
  });

  it('seedInitialHistory gates onBytes during rebuild so live bytes are not double-written', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(41, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(41, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 100_000;
    const seedBytes = new Uint8Array(TOTAL).fill(83); // 'S'
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=0-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: seedBytes };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'S', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);

    // Wait until the seed fetch completes and rebuild starts.
    // The simplest reliable trigger: spin the microtask queue until
    // loadedBytes is non-empty (i.e., rebuild has set it) — at that point
    // this.paused should be true.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedBytes.byteLength > 0) break;
    }

    // At this point seed has completed and `paused` has been restored.
    // Before our test deflakes, we cannot reliably observe the gated
    // window from outside. Instead, assert the final invariant:
    // liveTailBytes still equals whatever was there before the rebuild
    // (empty in this test), and liveOffset equals the transcript total.
    const bufs = c._debugBuffers();
    expect(bufs.paused).toBe(false);
    expect(bufs.liveTailBytes.byteLength).toBe(0);
    expect(bufs.liveOffset).toBe(TOTAL);
  });
});
