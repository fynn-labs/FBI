import { useEffect, useRef } from 'react';
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

function readTheme() {
  const s = getComputedStyle(document.documentElement);
  return {
    background: s.getPropertyValue('--surface-sunken').trim() || '#0b0f14',
    foreground: s.getPropertyValue('--text').trim() || '#e2e8f0',
    cursor: s.getPropertyValue('--accent').trim() || '#38bdf8',
  };
}

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Xterm({
      convertEol: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: readTheme(),
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const safeFit = () => {
      // Skip if the host has no real size yet — xterm's fit divides by cell
      // dimensions and will produce NaN cols/rows if the element is 0×0,
      // which manifests as malformed rendering.
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      try { fit.fit(); return true; } catch { return false; }
    };

    // Defer first fit + replay until after layout settles. xterm's FitAddon
    // uses getBoundingClientRect which can return stale/zero values during
    // the first paint, especially when the parent SplitPane just mounted.
    let disposed = false;
    const raf1 = requestAnimationFrame(() => {
      if (disposed) return;
      const raf2 = requestAnimationFrame(() => {
        if (disposed) return;
        safeFit();
        // Replay buffered bytes AFTER fit, so they render at the correct size.
        for (const chunk of getBuffer(runId)) term.write(chunk);
        if (interactive) term.focus();
      });
      // Cache inside the outer closure so cleanup can cancel it.
      (safeFit as unknown as { _raf?: number })._raf = raf2;
    });

    const observer = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Refit whenever the pane resizes (not just window resize). The SplitPane
    // divider drag or sidebar toggle changes the host's width without a
    // window resize event.
    const shell = acquireShell(runId);

    const ro = new ResizeObserver(() => {
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
    });
    ro.observe(host);

    const unsubBytes = shell.onBytes((data) => term.write(data));
    const unsubEv = shell.onTypedEvent<{ type: string; snapshot?: unknown }>((msg) => {
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'rate_limit') publishRateLimit(runId, msg.snapshot as RateLimitState);
      else if (msg.type === 'state') publishState(runId, msg as unknown as RunWsStateMessage);
    });

    const onResize = () => {
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);

    // Send initial size once socket opens.
    shell.onOpen(() => {
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
    });

    if (interactive) {
      term.onData((d) => shell.send(new TextEncoder().encode(d)));
      // Click anywhere in the pane focuses the terminal so typing registers.
      host.addEventListener('click', () => term.focus());
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf1);
      const raf2 = (safeFit as unknown as { _raf?: number })._raf;
      if (raf2 !== undefined) cancelAnimationFrame(raf2);
      ro.disconnect();
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      unsubBytes();
      unsubEv();
      releaseShell(runId);
      term.dispose();
    };
  }, [runId, interactive]);

  return <div ref={hostRef} className="h-full w-full bg-surface-sunken" />;
}
