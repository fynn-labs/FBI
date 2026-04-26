import type { RunWsSnapshotMessage } from '@shared/types.js';
import { wsBase } from './api.js';
import { record, bytesPreview, strPreview } from './terminalTrace.js';

export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): () => void;
  onTypedEvent<T extends { type: string }>(cb: (msg: T) => void): () => void;
  onSnapshot(cb: (snap: RunWsSnapshotMessage) => void): () => void;
  onOpen(cb: () => void): () => void;
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  sendHello(cols: number, rows: number): void;
  /** Tell the server this viewer is claiming focus (wants to drive PTY dims). */
  sendFocus(): void;
  /** Tell the server this viewer is relinquishing focus (tab hidden, etc.). */
  sendBlur(): void;
  close(): void;
}

const RECONNECT_DELAY_MS = 500;

export function openShell(runId: number): ShellHandle {
  const url = `${wsBase()}/api/runs/${runId}/shell`;

  // Subscriber arrays live across reconnects so the controller's
  // onBytes/onSnapshot/onOpen handlers wired once at mount keep firing
  // for every reconnect-served WS instance.
  const bytesCbs: Array<(d: Uint8Array) => void> = [];
  const typedCbs: Array<(msg: { type: string }) => void> = [];
  const snapshotCbs: Array<(s: RunWsSnapshotMessage) => void> = [];
  const openCbs: Array<() => void> = [];

  let ws: WebSocket;
  let userClosed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      record('ws.open', { runId });
      for (const cb of openCbs) cb();
    });
    ws.addEventListener('close', (e) => {
      record('ws.close', { runId, code: e.code, reason: e.reason });
      if (userClosed) return;
      // The server closes the WS when the run's broadcaster ends (terminal
      // run state). If the user clicks Continue, a new broadcaster is
      // created and a fresh WS will subscribe to it. Auto-reconnect so the
      // controller transparently reattaches to the new container's bytes.
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!userClosed) connect();
      }, RECONNECT_DELAY_MS);
    });
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
  };
  connect();

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
      // Persist across reconnects: every fresh WS open re-fires registered
      // callbacks so the controller can re-send hello and get a fresh
      // snapshot for the new container.
      openCbs.push(cb);
      if (ws.readyState === WebSocket.OPEN) queueMicrotask(cb);
      return () => { const i = openCbs.indexOf(cb); if (i !== -1) openCbs.splice(i, 1); };
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
    sendFocus: () => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.focus', {});
        ws.send(JSON.stringify({ type: 'focus' }));
      }
    },
    sendBlur: () => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.blur', {});
        ws.send(JSON.stringify({ type: 'blur' }));
      }
    },
    close: () => {
      userClosed = true;
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      ws.close();
    },
  };
}
