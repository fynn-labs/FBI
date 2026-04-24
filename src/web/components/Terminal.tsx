import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalController } from '../lib/terminalController.js';
import {
  record as traceRecord,
  isTracing,
  setTracing,
  subscribe as traceSubscribe,
  eventCount as traceEventCount,
  downloadTrace,
} from '../lib/terminalTrace.js';

interface Props {
  runId: number;
  interactive: boolean;
}

function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const bg = s.getPropertyValue('--surface-sunken').trim() || '#0b0f14';
  return {
    background: bg,
    foreground: s.getPropertyValue('--text').trim() || '#e2e8f0',
    cursor: bg,
    cursorAccent: bg,
  };
}

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const historyHostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [historyMode, setHistoryMode] = useState(false);
  // `ready` flips true after the opening snapshot has been parsed into xterm.
  // Used to hide the first-load fast-forward (buffered bytes the server
  // flushes right after the snapshot are noisy to the eye).
  const [ready, setReady] = useState(false);

  const [, forceTraceRerender] = useState(0);
  useEffect(() => traceSubscribe(() => forceTraceRerender((n) => n + 1)), []);
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
    traceRecord('term.mount', { runId });

    const observer = new MutationObserver(() => { term.options.theme = readTheme(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Fit BEFORE constructing the controller. Otherwise xterm sits at its
    // default 80×24 when the controller applies a cached snapshot (which
    // was serialized at the real viewport dims, typically 133×30), and
    // the snapshot reflows messily when the ResizeObserver fires the
    // first real fit a moment later. Doing it up-front keeps the xterm
    // at the real dims from the start.
    const rect = host.getBoundingClientRect();
    if (rect.width >= 4 && rect.height >= 4) {
      try { fit.fit(); } catch { /* layout may still be transitioning */ }
    }

    const controller = new TerminalController(runId, term, host);
    controllerRef.current = controller;
    // Sync React state to controller's ready state. Cache-hit mounts are
    // ready instantly (the controller wrote the cached snapshot in its
    // constructor); fresh mounts need to wait for the silence+cap timers.
    setReady(controller.isReady());
    if (!controller.isReady()) {
      controller.onReady(() => setReady(true));
    }

    // On tab-return, nudge Claude to repaint. A bare re-hello with the
    // same dims doesn't always trigger a Claude redraw (the server's
    // orchestrator.resize → Docker resize is a no-op for same dims).
    // controller.requestRedraw() briefly perturbs the PTY rows by one
    // and restores, forcing two SIGWINCHes and two Claude redraws. The
    // second redraw's bytes include the cursor cell.
    const onVisibility = () => {
      if (!document.hidden) controller.requestRedraw();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const safeFit = (): boolean => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      try { fit.fit(); return true; } catch { return false; }
    };

    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const runFit = () => {
      roTimer = null;
      if (safeFit()) controller.resize(term.cols, term.rows);
    };
    const ro = new ResizeObserver(() => {
      if (roTimer !== null) clearTimeout(roTimer);
      roTimer = setTimeout(runFit, 120);
    });
    ro.observe(host);

    let winResizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onWinResize = () => {
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      winResizeTimer = setTimeout(() => {
        winResizeTimer = null;
        if (safeFit()) controller.resize(term.cols, term.rows);
      }, 120);
    };
    window.addEventListener('resize', onWinResize);

    return () => {
      if (roTimer !== null) clearTimeout(roTimer);
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      ro.disconnect();
      observer.disconnect();
      window.removeEventListener('resize', onWinResize);
      document.removeEventListener('visibilitychange', onVisibility);
      // Dispose order: controller first (its `disposed` flag neutralises
      // the WS byte/snapshot callbacks), then term.dispose(). Reversing
      // would risk term.write() being called on a disposed xterm from an
      // in-flight byte callback before the controller unsubscribes.
      controller.dispose();
      controllerRef.current = null;
      term.dispose();
    };
  }, [runId]);

  useEffect(() => {
    controllerRef.current?.setInteractive(interactive);
  }, [interactive]);

  const onLoadHistory = async () => {
    setHistoryMode(true);
    await new Promise((r) => requestAnimationFrame(r));
    if (historyHostRef.current && controllerRef.current) {
      await controllerRef.current.enterHistory(historyHostRef.current);
    }
  };

  const onResumeLive = () => {
    controllerRef.current?.resumeLive();
    setHistoryMode(false);
  };

  return (
    <div className="relative h-full w-full bg-surface-sunken">
      {!ready && !historyMode && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-surface-sunken text-text-dim text-[12px]">
          <span>Loading terminal…</span>
        </div>
      )}
      {!historyMode && (
        <div className="absolute top-1 right-2 z-10">
          <button
            type="button"
            onClick={onLoadHistory}
            className="text-[11px] text-text-dim hover:text-text transition-colors duration-fast ease-out"
          >
            Load full history
          </button>
        </div>
      )}
      {historyMode && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
          <span>Viewing full history — live view continues in the background.</span>
          <button
            type="button"
            onClick={onResumeLive}
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
      <div
        ref={hostRef}
        className="h-full w-full"
        style={{ display: historyMode ? 'none' : 'block' }}
      />
      {historyMode && (
        <div ref={historyHostRef} className="absolute inset-0 h-full w-full bg-surface-sunken" />
      )}
    </div>
  );
}
