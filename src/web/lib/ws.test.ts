import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We have to mock the global WebSocket constructor because happy-dom's
// implementation won't actually connect. We care about our wrapper's
// state-handling logic, not real networking.
class MockWs {
  static instances: MockWs[] = [];
  readyState = 0; // CONNECTING
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  listeners = new Map<string, Array<(e: Event) => void>>();
  onmessage: ((e: MessageEvent) => void) | null = null;
  binaryType = '';
  constructor(_url: string) { MockWs.instances.push(this); }
  addEventListener(type: string, fn: (e: Event) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  send() {}
  close() { this.readyState = MockWs.CLOSED; }
  fireOpen() {
    this.readyState = MockWs.OPEN;
    (this.listeners.get('open') ?? []).forEach((f) => f(new Event('open')));
  }
}

beforeEach(() => {
  MockWs.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = MockWs;
});

afterEach(() => {
  MockWs.instances = [];
});

describe('ShellHandle.onOpenOrNow', () => {
  it('fires the callback asynchronously when the socket is already OPEN', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(42);
    const ws = MockWs.instances[0];
    ws.fireOpen();
    const cb = vi.fn();
    shell.onOpenOrNow(cb);
    // microtask flush
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires the callback when the socket transitions to OPEN later', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(43);
    const ws = MockWs.instances[0];
    const cb = vi.fn();
    shell.onOpenOrNow(cb);
    expect(cb).not.toHaveBeenCalled();
    ws.fireOpen();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('supports multiple independent callers (no {once:true} behavior)', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(44);
    const ws = MockWs.instances[0];
    ws.fireOpen();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    shell.onOpenOrNow(cb1);
    shell.onOpenOrNow(cb2);
    await Promise.resolve();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
