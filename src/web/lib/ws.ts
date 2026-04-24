import type { RunWsSnapshotMessage } from '@shared/types.js';
import { record, bytesPreview, strPreview } from './terminalTrace.js';

export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): () => void;
  onTypedEvent<T extends { type: string }>(cb: (msg: T) => void): () => void;
  onSnapshot(cb: (snap: RunWsSnapshotMessage) => void): () => void;
  onOpen(cb: () => void): () => void;
  onOpenOrNow(cb: () => void): () => void;
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  sendHello(cols: number, rows: number): void;
  sendResync(): void;
  close(): void;
}

export function openShell(runId: number): ShellHandle {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/runs/${runId}/shell`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => record('ws.open', { runId }));
  ws.addEventListener('close', (e) => record('ws.close', { runId, code: e.code, reason: e.reason }));
  const bytesCbs: Array<(d: Uint8Array) => void> = [];
  const typedCbs: Array<(msg: { type: string }) => void> = [];
  const snapshotCbs: Array<(s: RunWsSnapshotMessage) => void> = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data) as { type: string };
        if (msg.type === 'snapshot') {
          const snap = msg as unknown as RunWsSnapshotMessage;
          record('ws.in.snapshot', {
            cols: snap.cols, rows: snap.rows,
            ansiLen: snap.ansi.length,
            ansiPreview: strPreview(snap.ansi),
          });
          for (const cb of snapshotCbs) cb(snap);
          return;
        }
        record('ws.in.event', { type: msg.type, msg });
        for (const cb of typedCbs) cb(msg);
      } catch {
        const data = new TextEncoder().encode(ev.data);
        record('ws.in.bytes', { source: 'text-fallback', ...bytesPreview(data) });
        for (const cb of bytesCbs) cb(data);
      }
      return;
    }
    const data = ev.data instanceof ArrayBuffer
      ? new Uint8Array(ev.data)
      : new TextEncoder().encode('');
    record('ws.in.bytes', bytesPreview(data));
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
    onOpen: (cb) => {
      if (ws.readyState === WebSocket.OPEN) {
        queueMicrotask(cb);
        return () => {};
      }
      ws.addEventListener('open', cb);
      return () => ws.removeEventListener('open', cb);
    },
    onOpenOrNow: (cb) => {
      if (ws.readyState === WebSocket.OPEN) {
        queueMicrotask(cb);
        return () => {};
      }
      ws.addEventListener('open', cb);
      return () => ws.removeEventListener('open', cb);
    },
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.send', bytesPreview(data));
        ws.send(data);
      }
    },
    resize: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.resize', { cols, rows });
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    },
    sendHello: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.hello', { cols, rows });
        ws.send(JSON.stringify({ type: 'hello', cols, rows }));
      }
    },
    sendResync: () => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.resync', {});
        ws.send(JSON.stringify({ type: 'resync' }));
      }
    },
    close: () => ws.close(),
  };
}
