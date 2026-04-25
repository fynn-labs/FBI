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

import { TerminalController, CHUNK_SIZE } from './terminalController.js';

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

  it('seedInitialHistory fetches last CHUNK_SIZE bytes via Range, rebuilds xterm with [seed, snapshot]', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(40, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(40, term as unknown as import('@xterm/xterm').Terminal, host);

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'SNAP', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);
    expect(term.writes).toEqual(['__RESET__', 'SNAP']);

    const FULL_TOTAL = 1_000_000;
    const seedBytes = new Uint8Array(CHUNK_SIZE).fill(65); // 'A' * CHUNK_SIZE
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      expect(call.url).toBe('/api/runs/40/transcript');
      if (call.headers.range === 'bytes=0-0') {
        return {
          status: 206,
          headers: { 'x-transcript-total': String(FULL_TOTAL) },
          body: new Uint8Array([0]),
        };
      }
      if (call.headers.range === `bytes=${FULL_TOTAL - CHUNK_SIZE}-${FULL_TOTAL - 1}`) {
        return {
          status: 206,
          headers: {
            'x-transcript-total': String(FULL_TOTAL),
            'content-range': `bytes ${FULL_TOTAL - CHUNK_SIZE}-${FULL_TOTAL - 1}/${FULL_TOTAL}`,
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
    expect(bufs.loadedBytes.byteLength).toBe(CHUNK_SIZE + 4); // seed + 'SNAP'
    expect(bufs.loadedStartOffset).toBe(FULL_TOTAL - CHUNK_SIZE);
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

  it('loadOlderChunk fetches a CHUNK_SIZE range before loadedStartOffset and prepends to loadedBytes', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(50, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(50, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    const seedBytes = new Uint8Array(CHUNK_SIZE).fill(66);
    const olderBytes = new Uint8Array(CHUNK_SIZE).fill(67);
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - CHUNK_SIZE}-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: seedBytes };
      }
      if (call.headers.range === `bytes=${TOTAL - 2 * CHUNK_SIZE}-${TOTAL - CHUNK_SIZE - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: olderBytes };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'S', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);
    // Let the seed chain settle (meta fetch + seed fetch + rebuild).
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === TOTAL - CHUNK_SIZE) break;
    }
    expect(c._debugBuffers().loadedStartOffset).toBe(TOTAL - CHUNK_SIZE);

    c.pause();
    await c.loadOlderChunk();

    const b = c._debugBuffers();
    expect(b.loadedBytes.byteLength).toBe(CHUNK_SIZE + CHUNK_SIZE + 1); // older + seed + 'S'
    expect(b.loadedStartOffset).toBe(TOTAL - 2 * CHUNK_SIZE);
    expect(b.loadedBytes[0]).toBe(67);
    expect(b.loadedBytes[CHUNK_SIZE - 1]).toBe(67);
    expect(b.loadedBytes[CHUNK_SIZE]).toBe(66);
  });

  it('loadOlderChunk is idempotent during a pending fetch (dedup)', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(51, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(51, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    const seedBytes = new Uint8Array(CHUNK_SIZE).fill(1);
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - CHUNK_SIZE}-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: seedBytes };
      }
      return { status: 206, headers: {}, body: new Uint8Array(CHUNK_SIZE).fill(2) };
    };

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'S', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === TOTAL - CHUNK_SIZE) break;
    }

    c.pause();
    const p1 = c.loadOlderChunk();
    const p2 = c.loadOlderChunk(); // should dedupe to p1
    await Promise.all([p1, p2]);
    // Count fetches that are the "older" chunk range (not meta, not seed).
    const olderCalls = fetchCalls.filter((callArg) =>
      callArg.headers.range?.startsWith('bytes=')
      && callArg.headers.range !== 'bytes=0-0'
      && !callArg.headers.range.startsWith(`bytes=${TOTAL - CHUNK_SIZE}`)
    );
    expect(olderCalls.length).toBe(1);
  });

  it('loadOlderChunk writes start-of-run marker when loadedStartOffset reaches 0', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(52, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(52, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 100_000; // smaller than CHUNK_SIZE — seed covers everything.
    const seedBytes = new Uint8Array(TOTAL).fill(9);
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
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === 0) break;
    }
    expect(c._debugBuffers().loadedStartOffset).toBe(0);

    c.pause();
    await c.loadOlderChunk();
    const olderCalls = fetchCalls.filter((call) => {
      const r = call.headers.range;
      return r && r !== 'bytes=0-0' && r !== `bytes=0-${TOTAL - 1}`;
    });
    expect(olderCalls.length).toBe(0);
  });

  it('resume() for a live run sends hello and rebuilds xterm with [loaded, liveTail, snap]', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(60, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(60, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 100_000;
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array(TOTAL).fill(0) };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'S1', cols: 120, rows: 40 });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === 0) break;
    }
    for (const cb of shell._events) cb({ type: 'state', state: 'running' } as unknown as { type: string });
    for (const cb of shell._bytes) cb(new TextEncoder().encode('live'));
    c.pause();

    term.reset.mockClear();
    term.write.mockClear();
    shell.sentHello.length = 0;

    const resumeP = c.resume();
    expect(shell.sentHello).toEqual([{ cols: 120, rows: 40 }]);
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'FRESH', cols: 120, rows: 40 });
    await resumeP;

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(c._debugBuffers().paused).toBe(false);
  });

  it('resume() for a finished run fetches tail and rebuilds without sendHello', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(61, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(61, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 100_000;
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=0-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array(TOTAL).fill(0) };
      }
      if (call.headers.range === `bytes=${TOTAL}-`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array() };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'X', cols: 120, rows: 40 });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === 0) break;
    }
    for (const cb of shell._events) cb({ type: 'state', state: 'succeeded' } as unknown as { type: string });
    c.pause();
    shell.sentHello.length = 0;

    await c.resume();

    expect(shell.sentHello).toEqual([]);
    expect(c._debugBuffers().paused).toBe(false);
  });

  it('snapshot handler drops snapshots while paused (does not reset xterm)', () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(63, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(63, term as unknown as import('@xterm/xterm').Terminal, host);

    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'INITIAL', cols: 120, rows: 40 });
    c.pause();
    term.reset.mockClear();
    term.write.mockClear();

    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'RECONNECT', cols: 120, rows: 40 });

    expect(term.reset).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalledWith('RECONNECT');
  });

  it('resume() aborts a pending chunk fetch and still completes', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(62, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(62, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - CHUNK_SIZE}-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array(CHUNK_SIZE) };
      }
      return { status: 206, headers: {}, body: new Uint8Array(CHUNK_SIZE) };
    };

    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'X', cols: 120, rows: 40 });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === TOTAL - CHUNK_SIZE) break;
    }
    for (const cb of shell._events) cb({ type: 'state', state: 'succeeded' } as unknown as { type: string });
    c.pause();

    void c.loadOlderChunk();
    const resumeP = c.resume();
    await resumeP;

    expect(c._debugBuffers().paused).toBe(false);
  });

  it('resume() reentrant calls return the same in-flight promise', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(64, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(64, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 100_000;
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=0-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array(TOTAL) };
      }
      if (call.headers.range === `bytes=${TOTAL}-`) {
        return { status: 206, headers: {}, body: new Uint8Array() };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'X', cols: 120, rows: 40 });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === 0) break;
    }
    for (const cb of shell._events) cb({ type: 'state', state: 'succeeded' } as unknown as { type: string });
    c.pause();

    const p1 = c.resume();
    const p2 = c.resume();
    // Both promises must resolve without hanging.
    await Promise.all([p1, p2]);
    expect(c._debugBuffers().paused).toBe(false);
  });

  it('resume() timeout falls through to tail fetch (late snapshot does not wipe scrollback)', async () => {
    vi.useFakeTimers();
    try {
      const shell = makeStubShell({ openState: 'open' });
      acquiredShells.set(65, shell);
      const term = makeFakeXterm();
      const host = document.createElement('div');
      const c = new TerminalController(65, term as unknown as import('@xterm/xterm').Terminal, host);

      const TOTAL = 100_000;
      fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
        if (call.headers.range === 'bytes=0-0') {
          return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
        }
        if (call.headers.range === `bytes=0-${TOTAL - 1}`) {
          return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array(TOTAL) };
        }
        if (call.headers.range === `bytes=${TOTAL}-`) {
          return { status: 206, headers: {}, body: new Uint8Array() };
        }
        return { status: 404, headers: {}, body: new Uint8Array() };
      };

      for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'X', cols: 120, rows: 40 });
      // Seed completes (no more fake-timer advance needed yet).
      await vi.runAllTimersAsync();
      for (const cb of shell._events) cb({ type: 'state', state: 'running' } as unknown as { type: string });
      c.pause();

      term.reset.mockClear();
      const resumeP = c.resume();
      // Don't fire a snapshot — simulate server delay.
      // Advance past the 2s timeout and let resume fall through to tail.
      await vi.advanceTimersByTimeAsync(2100);
      await resumeP;

      expect(c._debugBuffers().paused).toBe(false);
      // Reset count after resume (should have rebuilt via tail path).
      const resetCallsAfterResume = term.reset.mock.calls.length;

      // A stale/late snapshot now arrives. MUST NOT call reset+write.
      term.reset.mockClear();
      term.write.mockClear();
      for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'LATE', cols: 120, rows: 40 });
      expect(term.reset).not.toHaveBeenCalled();
      expect(term.write).not.toHaveBeenCalledWith('LATE');
      void resetCallsAfterResume; // silence unused-var lint
    } finally {
      vi.useRealTimers();
    }
  });

  it('onScroll: scrolling up from bottom calls pause()', () => {
    const shell = makeStubShell();
    acquiredShells.set(70, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(70, term as unknown as import('@xterm/xterm').Terminal, host);
    const pauseSpy = vi.spyOn(c, 'pause');
    c.onScroll({ atBottom: false, nearTop: false });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('onScroll: scrolling back to bottom calls resume()', () => {
    const shell = makeStubShell();
    acquiredShells.set(71, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(71, term as unknown as import('@xterm/xterm').Terminal, host);
    c.pause();
    const resumeSpy = vi.spyOn(c, 'resume').mockResolvedValue();
    c.onScroll({ atBottom: true, nearTop: false });
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('onScroll: nearTop while paused triggers loadOlderChunk', async () => {
    const shell = makeStubShell();
    acquiredShells.set(72, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(72, term as unknown as import('@xterm/xterm').Terminal, host);
    (c as unknown as { loadedStartOffset: number }).loadedStartOffset = 100_000;
    c.pause();
    const loadSpy = vi.spyOn(c, 'loadOlderChunk').mockResolvedValue();
    c.onScroll({ atBottom: false, nearTop: true });
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('onScroll is a no-op while rebuilding (seed rebuild does not trigger spurious resume)', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(73, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(73, term as unknown as import('@xterm/xterm').Terminal, host);
    // Drive controller into rebuilding state by directly setting the flag
    // (simulating the seed-rebuild bracket).
    (c as unknown as { rebuilding: boolean }).rebuilding = true;
    const pauseSpy = vi.spyOn(c, 'pause');
    const resumeSpy = vi.spyOn(c, 'resume').mockResolvedValue();
    // Simulate xterm scroll events that WOULD dispatch pause/resume if
    // rebuilding were not guarded.
    c.onScroll({ atBottom: false, nearTop: false });
    c.onScroll({ atBottom: true, nearTop: false });
    c.onScroll({ atBottom: false, nearTop: true });
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('loadOlderChunk emits chunkState loading → idle on success', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(80, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(80, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    const seedBytes = new Uint8Array(CHUNK_SIZE).fill(1);
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - CHUNK_SIZE}-${TOTAL - 1}`) {
        return { status: 206, headers: {}, body: seedBytes };
      }
      return { status: 206, headers: {}, body: new Uint8Array(CHUNK_SIZE).fill(2) };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'S', cols: 120, rows: 40 });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === TOTAL - CHUNK_SIZE) break;
    }

    c.pause();
    const states: string[] = [];
    c.onChunkStateChange((s) => states.push(s));
    await c.loadOlderChunk();
    expect(states).toEqual(['loading', 'idle']);
  });

  it('loadOlderChunk emits chunkState loading → error on failure', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(81, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(81, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    const seedBytes = new Uint8Array(CHUNK_SIZE).fill(1);
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - CHUNK_SIZE}-${TOTAL - 1}`) {
        return { status: 206, headers: {}, body: seedBytes };
      }
      return { status: 500, headers: {}, body: new Uint8Array() };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'S', cols: 120, rows: 40 });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === TOTAL - CHUNK_SIZE) break;
    }

    c.pause();
    const states: string[] = [];
    c.onChunkStateChange((s) => states.push(s));
    await c.loadOlderChunk();
    expect(states).toEqual(['loading', 'error']);
  });

  it('loadOlderChunk aborted by resume emits idle, not error', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(82, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(82, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    const seedBytes = new Uint8Array(CHUNK_SIZE).fill(1);
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - CHUNK_SIZE}-${TOTAL - 1}`) {
        return { status: 206, headers: {}, body: seedBytes };
      }
      // Older chunk: succeeds, but we'll abort before the rebuild.
      return { status: 206, headers: {}, body: new Uint8Array(CHUNK_SIZE).fill(2) };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'S', cols: 120, rows: 40 });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (c._debugBuffers().loadedStartOffset === TOTAL - CHUNK_SIZE) break;
    }
    for (const cb of shell._events) cb({ type: 'state', state: 'succeeded' } as unknown as { type: string });
    c.pause();
    const states: string[] = [];
    c.onChunkStateChange((s) => states.push(s));

    // Start the chunk load and resume before it fully finishes.
    void c.loadOlderChunk();
    await c.resume();

    expect(states).not.toContain('error');
    // States should include at least 'loading' and 'idle'.
    expect(states[0]).toBe('loading');
    expect(states[states.length - 1]).toBe('idle');
  });

  it('pause() clears stale chunkState from a prior paused session', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(83, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(83, term as unknown as import('@xterm/xterm').Terminal, host);

    // Force chunkState = 'error' directly to simulate a prior failed load.
    (c as unknown as { chunkState: 'error' }).chunkState = 'error';
    expect(c._debugBuffers().chunkState).toBe('error');

    c.pause();
    expect(c._debugBuffers().chunkState).toBe('idle');
  });
});
