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
  const fg = s.getPropertyValue('--text').trim() || '#e2e8f0';
  const isLight = document.documentElement.classList.contains('light');

  const base = { background: bg, foreground: fg, cursor: bg, cursorAccent: bg };
  if (!isLight) return base;

  // Remap the 16 ANSI colors for legibility on a light background.
  // Xterm's defaults (brightYellow=#ffff00, brightWhite=#fff, etc.) are
  // invisible on light surfaces, so we substitute darker equivalents.
  return {
    ...base,
    black:         '#1e293b',
    red:           '#b91c1c',
    green:         '#15803d',
    yellow:        '#a16207',
    blue:          '#1d4ed8',
    magenta:       '#7e22ce',
    cyan:          '#0f766e',
    white:         '#475569',
    brightBlack:   '#334155',
    brightRed:     '#991b1b',
    brightGreen:   '#166534',
    brightYellow:  '#854d0e',
    brightBlue:    '#1e40af',
    brightMagenta: '#6b21a8',
    brightCyan:    '#155e75',
    brightWhite:   '#0f172a',
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
      // xterm's default is 1000 lines, which would silently cap our
      // lazy-loaded scrollback. A single 512 KB chunk already produces
      // ~4000 lines at typical line lengths, and users can load many
      // chunks back to transcript start. Set high enough to hold full
      // realistic runs (spec Q8: no cap in v1).
      scrollback: 1_000_000,
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

    // xterm's Terminal.onScroll fires for content-driven scrolls (new lines
    // appended to scrollback) but is suppressed for user-driven DOM scrolls
    // — xterm's Viewport class calls scrollLines(delta, suppressScrollEvent=true)
    // when syncing the native scrollTop change back to the buffer. So we
    // listen on the actual scrollable DOM element to catch user scrolls,
    // then read the up-to-date buffer state via detectScroll.
    const viewportEl = host.querySelector('.xterm-viewport') as HTMLElement | null;
    let scrollRaf: number | null = null;
    const onViewportScroll = () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        controller.onScroll(detectScroll(term));
      });
    };
    viewportEl?.addEventListener('scroll', onViewportScroll, { passive: true });

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
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      viewportEl?.removeEventListener('scroll', onViewportScroll);
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
            <span>⏸ Stream paused — you&apos;re viewing history.</span>
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
