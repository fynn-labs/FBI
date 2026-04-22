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

    const applySnapshot = (ansi: string) => {
      clearQueue();
      term.reset();
      // Snapshots are bounded by viewport size (scrollback:0 server-side),
      // so write synchronously — going through the rAF queue makes the
      // user see the snapshot drawn line-by-line on tab switch.
      term.write(new TextEncoder().encode(ansi));
      ready = true;
      if (!disposed) setLoaded(true);
    };

    // If another component has already acquired the shell and cached a
    // snapshot, apply it synchronously on mount — otherwise wait for one.
    const cached = getLastSnapshot(runId);
    if (cached) applySnapshot(cached.ansi);

    unsubSnapshot = shell.onSnapshot((snap) => {
      // Every snapshot (initial OR resync response) resets the view.
      applySnapshot(snap.ansi);
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
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const runFit = () => {
      roTimer = null;
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
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
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      winResizeTimer = setTimeout(() => {
        winResizeTimer = null;
        if (safeFit() && interactive) shell.resize(term.cols, term.rows);
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
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
    });

    // "Load full history": fetch the log file and render it instead of the
    // live view. Exposed via loadFullRef so the JSX button can call it.
    loadFullRef.current = async () => {
      if (disposed) return;
      setHistoryMode(true);
      setLoaded(true); // history view is content; suppress the loading overlay
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
        enqueueWrite(buf);
      } catch {
        if (disposed) return;
        enqueueWrite(new TextEncoder().encode('\r\n[failed to load history]\r\n'));
      }
    };

    const resumeLive = () => {
      if (disposed) return;
      setHistoryMode(false);
      clearQueue();
      term.reset();
      ready = false;
      setLoaded(false); // show loading until the resync snapshot lands
      unsubSnapshot = shell.onSnapshot((snap) => applySnapshot(snap.ansi));
      unsubBytes = shell.onBytes((data) => { if (ready) enqueueWrite(data); });
      requestResync(runId);
    };
    // Stash resumeLive on the ref so the JSX button can call it.
    (loadFullRef as unknown as { resume?: () => void }).resume = resumeLive;

    if (interactive) {
      term.onData((d) => shell.send(new TextEncoder().encode(d)));
      host.addEventListener('click', () => term.focus());
    }

    return () => {
      disposed = true;
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
          <span>Loading terminal…</span>
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
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
