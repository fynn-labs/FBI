import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  acquireShell,
  releaseShell,
  getLastSnapshot,
  requestResync,
} from '../lib/shellRegistry.js';
import { publishUsage, publishState, publishTitle } from '../features/runs/usageBus.js';
import {
  record as traceRecord,
  strPreview,
  isTracing,
  setTracing,
  subscribe as traceSubscribe,
  eventCount as traceEventCount,
  downloadTrace,
} from '../lib/terminalTrace.js';
import type {
  UsageSnapshot,
  RunWsStateMessage,
  RunWsTitleMessage,
} from '@shared/types.js';

interface Props {
  runId: number;
  interactive: boolean;
}

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

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const loadFullRef = useRef<() => void>(() => {});
  const [historyMode, setHistoryMode] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Re-render the trace indicator whenever trace state or count changes.
  const [, forceTraceRerender] = useState(0);
  useEffect(() => traceSubscribe(() => forceTraceRerender((n) => n + 1)), []);
  // Ctrl+Shift+D toggles tracing globally for the whole app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setTracing(!isTracing());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    traceRecord('term.mount', { runId, interactive });

    const safeFit = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      try {
        fit.fit();
        traceRecord('term.fit', { cols: term.cols, rows: term.rows });
        return true;
      } catch { return false; }
    };

    let disposed = false;

    // Frame-paced write queue. All writes — snapshot replay, live bytes,
    // history-mode load — go through this.
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
      // Small writes (e.g. keystroke echoes from the PTY) bypass the rAF
      // queue and write directly so input round-trip stays snappy.
      // Otherwise every echo waits up to ~16ms for the next frame, which
      // adds visible per-keystroke lag on top of network RTT. Only fall
      // through to the queue if it's already pumping (preserves order)
      // or the chunk is large (worth pacing across frames).
      if (data.byteLength <= WRITE_CHUNK && writeQueue.length === 0 && !pumping) {
        traceRecord('term.write', { len: data.byteLength, path: 'direct' });
        term.write(data);
        return;
      }
      traceRecord('term.write', { len: data.byteLength, path: 'queue' });
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

    const clearQueue = () => { writeQueue.length = 0; };

    const shell = acquireShell(runId);
    let unsubBytes: (() => void) | null = null;
    let unsubSnapshot: (() => void) | null = null;
    let ready = false; // true once first snapshot has been applied

    const applySnapshot = (snap: { ansi: string; cols: number; rows: number }) => {
      // Non-interactive views don't drive the server's dims (an interactive
      // tab owns the PTY size), so we adopt whatever the server sends rather
      // than drop the snapshot. Resize before writing so the alt-screen
      // reset and content land on a buffer of the correct shape.
      if (!interactive && (snap.cols !== term.cols || snap.rows !== term.rows)) {
        traceRecord('term.adoptSnapDims', {
          fromCols: term.cols, fromRows: term.rows,
          toCols: snap.cols, toRows: snap.rows,
        });
        term.resize(snap.cols, snap.rows);
      }
      traceRecord('term.applySnapshot', {
        ansiLen: snap.ansi.length,
        termCols: term.cols,
        termRows: term.rows,
        ansiPreview: strPreview(snap.ansi),
      });
      clearQueue();
      // No pre-reset: the snapshot's leading modesAnsi takes care of
      // buffer selection (?1049h/l), viewport clear, and scroll region.
      // Previously this wrote \x1b[?1049l\x1b[?1049h to force alt-buffer,
      // but Claude Code renders its TUI inline in the *main* buffer —
      // forcing alt diverged the client from the server and the TUI's
      // relative cursor moves landed on wrong rows.
      //
      // Snapshots are bounded by viewport size (scrollback:0 server-side),
      // so write synchronously — going through the rAF queue makes the
      // user see the snapshot drawn line-by-line on tab switch.
      term.write(new TextEncoder().encode(snap.ansi));
      ready = true;
      if (!disposed) setLoaded(true);
    };

    // For interactive views we drop mismatched snapshots (e.g. the server's
    // first auto-snapshot before our resize lands) to avoid a visible flash
    // of mis-wrapped content — the server re-sends a matching snapshot after
    // our resize reaches it. Non-interactive views always accept.
    const shouldApply = (snap: { cols: number; rows: number }): boolean =>
      !interactive || (snap.cols === term.cols && snap.rows === term.rows);

    // If another component has already acquired the shell and cached a
    // snapshot for this run, apply it synchronously on mount.
    const cached = getLastSnapshot(runId);
    if (cached && shouldApply(cached)) applySnapshot(cached);

    unsubSnapshot = shell.onSnapshot((snap) => {
      if (!shouldApply(snap)) {
        traceRecord('term.dropSnapshot', {
          reason: 'dimMismatch',
          snapCols: snap.cols, snapRows: snap.rows,
          termCols: term.cols, termRows: term.rows,
        });
        return;
      }
      applySnapshot(snap);
    });

    unsubBytes = shell.onBytes((data) => {
      // Drop live bytes until the first snapshot has arrived; the snapshot
      // encodes the initial state, and out-of-order pre-snapshot bytes would
      // corrupt it. After ready=true, forward everything.
      if (!ready) return;
      enqueueWrite(data);
    });

    if (interactive) term.focus();

    const observer = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Debounced resize — the fit addon's getBoundingClientRect can be
    // expensive, and SplitPane/window drags fire continuously.
    // Non-interactive views skip fit entirely: they adopt the server's
    // dims via applySnapshot, and auto-fitting to container would fight
    // that and can re-flow content that was absolute-positioned at the
    // server's dims.
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const runFit = () => {
      roTimer = null;
      if (!interactive) return;
      if (safeFit()) shell.resize(term.cols, term.rows);
    };
    const ro = new ResizeObserver(() => {
      if (roTimer !== null) clearTimeout(roTimer);
      roTimer = setTimeout(runFit, 120);
    });
    ro.observe(host);

    // Same debounce for window resize — user dragging the browser edge
    // fires continuously; fit once after they stop.
    let winResizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (!interactive) return;
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      winResizeTimer = setTimeout(() => {
        winResizeTimer = null;
        if (safeFit()) shell.resize(term.cols, term.rows);
      }, 120);
    };
    window.addEventListener('resize', onResize);

    const unsubEv = shell.onTypedEvent<{ type: string; snapshot?: unknown }>((msg) => {
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'state') publishState(runId, msg as unknown as RunWsStateMessage);
      else if (msg.type === 'title') publishTitle(runId, msg as unknown as RunWsTitleMessage);
    });

    // Focus/blur/visibility triggers the fast-forward fix. When the window
    // has been blurred or the tab hidden, rAF has been throttled and the
    // write queue may have filled with stale bytes. On return, drop the
    // queue and ask the server for a fresh snapshot.
    let stale = false;
    const markStale = () => { stale = true; };
    const refresh = () => {
      if (!stale || unsubSnapshot === null) return;
      stale = false;
      clearQueue();
      traceRecord('term.resync.request', { reason: 'focus' });
      requestResync(runId);
      // The next snapshot frame will land via unsubSnapshot → applySnapshot.
    };
    const onVisChange = () => {
      if (document.hidden) markStale();
      else refresh();
    };
    window.addEventListener('blur', markStale);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisChange);

    shell.onOpen(() => {
      if (interactive && safeFit()) shell.resize(term.cols, term.rows);
    });

    // "Load full history": fetch the log file and render it instead of the
    // live view. Exposed via loadFullRef so the JSX button can call it.
    loadFullRef.current = async () => {
      if (disposed) return;
      traceRecord('term.history.start', { runId });
      setHistoryMode(true);
      setLoaded(false); // show loading while we fetch + write the transcript
      if (unsubBytes) { unsubBytes(); unsubBytes = null; }
      if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
      clearQueue();
      term.reset();
      try {
        const res = await fetch(`/api/runs/${runId}/transcript`);
        if (disposed) return;
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (disposed) return;
        // Write atomically in 1 MB chunks chained via xterm's write callback.
        // The rAF-paced queue would draw the transcript line-by-line, which is
        // intensely jittery for big logs; xterm's internal parser handles
        // large writes far faster than one rAF per 16 KB.
        const HISTORY_CHUNK = 1024 * 1024;
        for (let off = 0; off < buf.byteLength; off += HISTORY_CHUNK) {
          if (disposed) return;
          const end = Math.min(off + HISTORY_CHUNK, buf.byteLength);
          await new Promise<void>((resolve) => term.write(buf.subarray(off, end), resolve));
        }
        if (!disposed) setLoaded(true);
        traceRecord('term.history.end', { runId, bytes: buf.byteLength });
      } catch {
        if (disposed) return;
        term.write(new TextEncoder().encode('\r\n[failed to load history]\r\n'));
        setLoaded(true);
        traceRecord('term.history.end', { runId, error: true });
      }
    };

    const resumeLive = () => {
      if (disposed) return;
      setHistoryMode(false);
      clearQueue();
      term.reset();
      ready = false;
      setLoaded(false); // show loading until the resync snapshot lands
      unsubSnapshot = shell.onSnapshot((snap) => {
        if (!shouldApply(snap)) {
          traceRecord('term.dropSnapshot', {
            reason: 'dimMismatch.resume',
            snapCols: snap.cols, snapRows: snap.rows,
            termCols: term.cols, termRows: term.rows,
          });
          return;
        }
        applySnapshot(snap);
      });
      unsubBytes = shell.onBytes((data) => { if (ready) enqueueWrite(data); });
      traceRecord('term.resync.request', { reason: 'resumeLive' });
      requestResync(runId);
    };
    // Stash resumeLive on the ref so the JSX button can call it.
    (loadFullRef as unknown as { resume?: () => void }).resume = resumeLive;

    if (interactive) {
      term.onData((d) => {
        traceRecord('term.input', strPreview(d));
        shell.send(new TextEncoder().encode(d));
      });
      host.addEventListener('click', () => term.focus());
    }

    return () => {
      disposed = true;
      traceRecord('term.unmount', { runId });
      if (roTimer !== null) clearTimeout(roTimer);
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      ro.disconnect();
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', markStale);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisChange);
      if (unsubBytes) unsubBytes();
      if (unsubSnapshot) unsubSnapshot();
      unsubEv();
      releaseShell(runId);
      term.dispose();
    };
  }, [runId, interactive]);

  return (
    <div className="relative h-full w-full bg-surface-sunken">
      {!loaded && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-sunken text-text-dim text-[12px]">
          <span>{historyMode ? 'Loading history…' : 'Loading terminal…'}</span>
        </div>
      )}
      {!historyMode && (
        <div className="absolute top-1 right-2 z-10">
          <button
            type="button"
            onClick={() => loadFullRef.current()}
            className="text-[11px] text-text-dim hover:text-text transition-colors duration-fast ease-out"
          >
            Load full history
          </button>
        </div>
      )}
      {historyMode && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
          <span>Viewing full history (live updates paused).</span>
          <button
            type="button"
            onClick={() => (loadFullRef as unknown as { resume?: () => void }).resume?.()}
            className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
          >
            Resume live
          </button>
        </div>
      )}
      {isTracing() && (
        <div
          className="absolute bottom-1 right-2 z-30 select-none rounded bg-red-900/80 px-2 py-0.5 text-[10px] font-mono text-red-100 shadow ring-1 ring-red-300/30 backdrop-blur"
          title="Terminal trace recording (Ctrl+Shift+D to stop). Click to download."
        >
          <button
            type="button"
            onClick={() => downloadTrace()}
            className="cursor-pointer"
          >
            ● REC {traceEventCount()} ↓
          </button>
        </div>
      )}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
