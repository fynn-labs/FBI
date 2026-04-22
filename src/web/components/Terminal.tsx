import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openShell } from '../lib/ws.js';
import { publishUsage, publishRateLimit } from '../features/runs/usageBus.js';
import type { UsageSnapshot, RateLimitState } from '@shared/types.js';

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
    if (!hostRef.current) return;
    const term = new Xterm({
      convertEol: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const observer = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const shell = openShell(runId);
    const unsubBytes = shell.onBytes((data) => term.write(data));
    const unsubEv = shell.onTypedEvent<{ type: string; snapshot: unknown }>((msg) => {
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'rate_limit') publishRateLimit(runId, msg.snapshot as RateLimitState);
    });

    const onResize = () => {
      fit.fit();
      if (interactive) shell.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);

    // Send initial size once socket opens.
    shell.onOpen(() => {
      fit.fit();
      if (interactive) shell.resize(term.cols, term.rows);
    });

    if (interactive) {
      term.onData((d) => shell.send(new TextEncoder().encode(d)));
    }

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      unsubBytes();
      unsubEv();
      shell.close();
      term.dispose();
    };
  }, [runId, interactive]);

  return <div ref={hostRef} className="h-full w-full bg-surface-sunken" />;
}
