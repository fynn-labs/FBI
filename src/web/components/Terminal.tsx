import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalController } from '../lib/terminalController.js';
import { detectScroll } from '../lib/scrollDetection.js';
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
  const controllerRef = useRef<TerminalController | null>(null);
  const [paused, setPaused] = useState(false);
  const [chunkState, setChunkState] = useState<'idle' | 'loading' | 'error'>('idle');
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

    const rect = host.getBoundingClientRect();
    if (rect.width >= 4 && rect.height >= 4) {
      try { fit.fit(); } catch { /* layout may still be transitioning */ }
    }

    const controller = new TerminalController(runId, term, host);
    controllerRef.current = controller;
    setReady(controller.isReady());
    if (!controller.isReady()) {
      controller.onReady(() => setReady(true));
    }

    const unsubPause = controller.onPauseChange((p) => setPaused(p));
    const unsubChunkState = controller.onChunkStateChange((s) => setChunkState(s));

    const scrollDisposable = term.onScroll(() => {
      const s = detectScroll(term);
      controller.onScroll(s);
    });

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
      unsubPause();
      unsubChunkState();
      scrollDisposable.dispose();
      controller.dispose();
      controllerRef.current = null;
      term.dispose();
    };
  }, [runId]);

  useEffect(() => {
    controllerRef.current?.setInteractive(interactive);
  }, [interactive, runId]);

  const onResumeClick = () => {
    void controllerRef.current?.resume();
  };

  return (
    <div className="relative h-full w-full bg-surface-sunken">
      {!ready && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-surface-sunken text-text-dim text-[12px]">
          <span>Loading terminal…</span>
        </div>
      )}
      {paused && (
        <div className="absolute top-0 left-0 right-0 z-10 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
            <span>⏸ Stream paused — you're viewing history.</span>
            <button
              type="button"
              onClick={onResumeClick}
              className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
            >
              Resume stream
            </button>
          </div>
          {chunkState !== 'idle' && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[11px] text-text-dim"
            >
              {chunkState === 'loading' && <span>Loading older history…</span>}
              {chunkState === 'error' && (
                <>
                  <span>Failed to load older history.</span>
                  <button
                    type="button"
                    onClick={() => void controllerRef.current?.loadOlderChunk()}
                    className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          )}
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
