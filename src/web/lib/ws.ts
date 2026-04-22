import type { RunWsSnapshotMessage } from '@shared/types.js';

export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): () => void;
  onTypedEvent<T extends { type: string }>(cb: (msg: T) => void): () => void;
  onSnapshot(cb: (snap: RunWsSnapshotMessage) => void): () => void;
  onOpen(cb: () => void): void;
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  sendResync(): void;
  close(): void;
}

export function openShell(runId: number): ShellHandle {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/runs/${runId}/shell`);
  ws.binaryType = 'arraybuffer';
  const bytesCbs: Array<(d: Uint8Array) => void> = [];
  const typedCbs: Array<(msg: { type: string }) => void> = [];
  const snapshotCbs: Array<(s: RunWsSnapshotMessage) => void> = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data) as { type: string };
        if (msg.type === 'snapshot') {
          for (const cb of snapshotCbs) cb(msg as unknown as RunWsSnapshotMessage);
          return;
        }
        for (const cb of typedCbs) cb(msg);
      } catch {
        const data = new TextEncoder().encode(ev.data);
        for (const cb of bytesCbs) cb(data);
      }
      return;
    }
    const data = ev.data instanceof ArrayBuffer
      ? new Uint8Array(ev.data)
      : new TextEncoder().encode('');
    for (const cb of bytesCbs) cb(data);
  };
  return {
    onBytes: (cb) => {
      bytesCbs.push(cb);
      return () => { const i = bytesCbs.indexOf(cb); if (i !== -1) bytesCbs.splice(i, 1); };
    },
    onTypedEvent: <T extends { type: string }>(cb: (msg: T) => void) => {
      const wrapper = (msg: { type: string }) => cb(msg as T);
      typedCbs.push(wrapper);
      return () => { const i = typedCbs.indexOf(wrapper); if (i !== -1) typedCbs.splice(i, 1); };
    },
    onSnapshot: (cb) => {
      snapshotCbs.push(cb);
      return () => { const i = snapshotCbs.indexOf(cb); if (i !== -1) snapshotCbs.splice(i, 1); };
    },
    onOpen: (cb) => { ws.addEventListener('open', cb, { once: true }); },
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    resize: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    sendResync: () => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resync' }));
    },
    close: () => ws.close(),
  };
}
