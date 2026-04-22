export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): () => void;
  onOpen(cb: () => void): void;
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export function openShell(runId: number): ShellHandle {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/runs/${runId}/shell`);
  ws.binaryType = 'arraybuffer';
  const cbs: Array<(d: Uint8Array) => void> = [];
  ws.onmessage = (ev) => {
    const data =
      ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new TextEncoder().encode(typeof ev.data === 'string' ? ev.data : '');
    for (const cb of cbs) cb(data);
  };
  return {
    onBytes: (cb) => {
      cbs.push(cb);
      return () => { const i = cbs.indexOf(cb); if (i !== -1) cbs.splice(i, 1); };
    },
    onOpen: (cb) => { ws.addEventListener('open', cb, { once: true }); },
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    resize: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    close: () => ws.close(),
  };
}
