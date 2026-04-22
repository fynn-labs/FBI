import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { acquireShell, releaseShell, getBuffer } from '../lib/shellRegistry.js';
import { publishUsage, publishRateLimit, publishState } from '../features/runs/usageBus.js';
import type { UsageSnapshot, RateLimitState, RunWsStateMessage } from '@shared/types.js';

interface Props {
  runId: number;
  interactive: boolean;
}

// Captured logs can be multi-megabyte. Writing them to xterm synchronously
// stalls the main thread and produces a "borked" initial render. On first
// mount we write only the most recent slice; full history is loadable on
// demand via the banner button.
const REPLAY_CAP = 100 * 1024;
const TRIM_SEARCH_WINDOW = 4096; // look this far past the cut for a newline
const WRITE_CHUNK = 16 * 1024;

function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const bg = s.getPropertyValue('--surface-sunken').trim() || '#0b0f14';
  return {
    background: bg,
    foreground: s.getPropertyValue('--text').trim() || '#e2e8f0',
    // Paint xterm's cursor the same colour as the background so it never
    // shows. Claude Code renders its own cursor inside the PTY output.
    cursor: bg,
    cursorAccent: bg,
  };
}

function mergeBuffer(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return merged;
}

// Slice to the last REPLAY_CAP bytes, advancing to the next newline so we
// don't cut a line (or an ANSI escape sequence) in half.
function trimToTail(data: Uint8Array): { tail: Uint8Array; trimmedBytes: number } {
  if (data.byteLength <= REPLAY_CAP) return { tail: data, trimmedBytes: 0 };
  const cutFrom = data.byteLength - REPLAY_CAP;
  for (let i = cutFrom; i < Math.min(cutFrom + TRIM_SEARCH_WINDOW, data.byteLength); i++) {
    if (data[i] === 0x0A) return { tail: data.subarray(i + 1), trimmedBytes: i + 1 };
  }
  return { tail: data.subarray(cutFrom), trimmedBytes: cutFrom };
}

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const loadFullRef = useRef<() => void>(() => {});
  const [trimmedBytes, setTrimmedBytes] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Xterm({
      convertEol: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: readTheme(),
      cursorBlink: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const safeFit = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      try { fit.fit(); return true; } catch { return false; }
    };

    let disposed = false;

    // All writes go through a serial queue. Any chunk larger than WRITE_CHUNK
    // is split into <=WRITE_CHUNK pieces and enqueued in order. The queue is
    // drained one piece per animation frame so a big incoming chunk — even
    // the server's flush-after-handshake that arrives right after the main
    // replay — never stalls the main thread for more than a frame.
    //
    // xterm's parser is stateful: splitting an ANSI escape sequence across
    // writes is safe because it holds partial sequences internally and
    // reassembles them on the next write.
    const writeQueue: Uint8Array[] = [];
    let pumping = false;
    const pump = () => {
      if (disposed) { pumping = false; return; }
      const chunk = writeQueue.shift();
      if (!chunk) { pumping = false; return; }
      term.write(chunk);
      requestAnimationFrame(pump);
    };
    const enqueueWrite = (data: Uint8Array): void => {
      if (data.byteLength === 0) return;
      if (data.byteLength <= WRITE_CHUNK) {
        writeQueue.push(data);
      } else {
        let offset = 0;
        while (offset < data.byteLength) {
          const end = Math.min(offset + WRITE_CHUNK, data.byteLength);
          writeQueue.push(data.subarray(offset, end));
          offset = end;
        }
      }
      if (!pumping) {
        pumping = true;
        requestAnimationFrame(pump);
      }
    };

    // writeReplay is the ONLY path for "this is a captured log being played
    // back". It trims if the log is large, and tracks how much was trimmed
    // so the banner can show a "Load full history" affordance.
    let initialWritten = false;
    const writeReplay = (data: Uint8Array): void => {
      if (initialWritten) return; // only the first replay is trimmed
      initialWritten = true;
      const { tail, trimmedBytes: tb } = trimToTail(data);
      if (!disposed) setTrimmedBytes(tb);
      enqueueWrite(tail);
    };

    const shell = acquireShell(runId);
    let unsubBytes: (() => void) | null = null;

    // loadFullHistory: user clicked "Load full history".
    // - Pause the live subscription so the next term.reset + replay doesn't
    //   double-write bytes that would also arrive through the live path.
    // - Reset the terminal (clears screen + scrollback + parser state).
    // - Replay the FULL current buffer (now including anything that's
    //   arrived since mount).
    // - Re-subscribe to live. Any bytes the registry captured while we were
    //   writing merge will be picked up by the registry's own buffer; the
    //   post-write delta is written once to catch up.
    loadFullRef.current = () => {
      if (disposed) return;
      if (unsubBytes) { unsubBytes(); unsubBytes = null; }
      // Drop any pending queued writes — the term.reset() below nukes
      // them anyway.
      writeQueue.length = 0;
      const merged = mergeBuffer(getBuffer(runId));
      const beforeBytes = merged.byteLength;
      term.reset();
      enqueueWrite(merged);
      setTrimmedBytes(0);
      // Re-subscribe; catch-up for any bytes the registry accumulated
      // between our getBuffer read and this moment is handled by reading
      // the buffer one more time next tick.
      queueMicrotask(() => {
        if (disposed) return;
        const after = mergeBuffer(getBuffer(runId));
        if (after.byteLength > beforeBytes) {
          enqueueWrite(after.subarray(beforeBytes));
        }
        unsubBytes = shell.onBytes((data) => enqueueWrite(data));
      });
    };

    // Defer first fit + replay until after layout settles. xterm's FitAddon
    // uses getBoundingClientRect which can return stale/zero values during
    // the first paint, especially when the parent SplitPane just mounted.
    const raf1 = requestAnimationFrame(() => {
      if (disposed) return;
      const raf2 = requestAnimationFrame(() => {
        if (disposed) return;
        safeFit();
        const buf = getBuffer(runId);
        if (buf.length > 0) writeReplay(mergeBuffer(buf));
        // Subscribe to live bytes AFTER replay. If getBuffer was empty
        // (WS hasn't sent the replay yet), the first large onBytes call
        // is itself the replay — treat it as such.
        unsubBytes = shell.onBytes((data) => {
          // Only the very first chunk is trimmed (it's the full log replay).
          // Everything after is live data — enqueue all of it; the serial
          // frame-paced queue keeps xterm responsive even on a big post-
          // replay flush.
          if (!initialWritten) writeReplay(data);
          else enqueueWrite(data);
        });
        if (interactive) term.focus();
      });
      (safeFit as unknown as { _raf?: number })._raf = raf2;
    });

    const observer = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Coalesce ResizeObserver callbacks into one fit per frame.
    let roRaf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (roRaf !== null) return;
      roRaf = requestAnimationFrame(() => {
        roRaf = null;
        if (safeFit() && interactive) shell.resize(term.cols, term.rows);
      });
    });
    ro.observe(host);

    const unsubEv = shell.onTypedEvent<{ type: string; snapshot?: unknown }>((msg) => {
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'rate_limit') publishRateLimit(runId, msg.snapshot as RateLimitState);
      else if (msg.type === 'state') publishState(runId, msg as unknown as RunWsStateMessage);
    });

    const onResize = () => {
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);

    shell.onOpen(() => {
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
    });

    if (interactive) {
      term.onData((d) => shell.send(new TextEncoder().encode(d)));
      host.addEventListener('click', () => term.focus());
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf1);
      const raf2 = (safeFit as unknown as { _raf?: number })._raf;
      if (raf2 !== undefined) cancelAnimationFrame(raf2);
      if (roRaf !== null) cancelAnimationFrame(roRaf);
      ro.disconnect();
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      if (unsubBytes) unsubBytes();
      unsubEv();
      releaseShell(runId);
      term.dispose();
    };
  }, [runId, interactive]);

  return (
    <div className="relative h-full w-full bg-surface-sunken">
      {trimmedBytes > 0 && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
          <span>Older output truncated ({Math.round(trimmedBytes / 1024).toLocaleString()} KB).</span>
          <button
            type="button"
            onClick={() => loadFullRef.current()}
            className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
          >
            Load full history
          </button>
        </div>
      )}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
