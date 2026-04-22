import { openShell, type ShellHandle } from './ws.js';

interface Entry {
  shell: ShellHandle;
  refCount: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  buffer: Uint8Array[];
}

const TTL_MS = 60_000; // keep the socket warm for 60s after last unmount
const BUFFER_CAP = 1024 * 1024; // 1 MB

const cache = new Map<number, Entry>();

function makeEntry(runId: number): Entry {
  const shell = openShell(runId);
  const entry: Entry = { shell, refCount: 1, closeTimer: null, buffer: [] };
  let bufferedBytes = 0;

  shell.onBytes((data) => {
    entry.buffer.push(data);
    bufferedBytes += data.byteLength;
    // Drop oldest entries when over cap.
    while (bufferedBytes > BUFFER_CAP && entry.buffer.length > 0) {
      const oldest = entry.buffer.shift()!;
      bufferedBytes -= oldest.byteLength;
    }
  });

  cache.set(runId, entry);
  return entry;
}

export function acquireShell(runId: number): ShellHandle {
  let entry = cache.get(runId);
  if (entry) {
    entry.refCount += 1;
    if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
    return entry.shell;
  }
  return makeEntry(runId).shell;
}

export function releaseShell(runId: number): void {
  const entry = cache.get(runId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  // Start TTL; if nothing re-acquires, close.
  entry.closeTimer = setTimeout(() => {
    entry.shell.close();
    cache.delete(runId);
  }, TTL_MS);
}

export function getBuffer(runId: number): ReadonlyArray<Uint8Array> {
  return cache.get(runId)?.buffer ?? [];
}

// For tests.
export function _reset(): void {
  for (const e of cache.values()) {
    if (e.closeTimer) clearTimeout(e.closeTimer);
    e.shell.close();
  }
  cache.clear();
}
