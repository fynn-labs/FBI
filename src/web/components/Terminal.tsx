import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openShell } from '../lib/ws.js';

interface Props {
  runId: number;
  interactive: boolean;
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
      theme: { background: '#111827' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const shell = openShell(runId);
    shell.onBytes((data) => term.write(data));

    const onResize = () => {
      fit.fit();
      if (interactive) shell.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);
    onResize();

    if (interactive) {
      term.onData((d) => shell.send(new TextEncoder().encode(d)));
    }

    return () => {
      window.removeEventListener('resize', onResize);
      shell.close();
      term.dispose();
    };
  }, [runId, interactive]);

  return <div ref={hostRef} className="h-[70vh] bg-[#111827] rounded border" />;
}
