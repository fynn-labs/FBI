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
      cursorBlink: interactive,
      // Hide the caret when the terminal isn't focused — kills the "floating
      // blue cursor" that showed up for non-interactive read-only panes.
      cursorInactiveStyle: 'none',
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

    // Write big buffers in ~32KB slices so xterm's parser yields to the
    // renderer between chunks. Writing a single 1MB+ replay in one shot
    // stalls the main thread long enough that the terminal renders in a
    // broken intermediate state.
    const WRITE_CHUNK = 32 * 1024;
    const writeChunked = (data: Uint8Array): void => {
      if (data.byteLength <= WRITE_CHUNK) { term.write(data); return; }
      let offset = 0;
      const pump = () => {
        if (disposed || offset >= data.byteLength) return;
        const end = Math.min(offset + WRITE_CHUNK, data.byteLength);
        term.write(data.subarray(offset, end), () => {
          offset = end;
          if (offset < data.byteLength) pump();
        });
      };
      pump();
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
        const buf = getBuffer(runId);
        if (buf.length > 0) {
          const total = buf.reduce((s, c) => s + c.byteLength, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const c of buf) { merged.set(c, offset); offset += c.byteLength; }
          writeChunked(merged);
        }
        // For read-only panes, hide the cursor entirely (DECTCEM off) so
        // there's no vestigial caret at the end of the captured log.
        if (!interactive) term.write('\x1b[?25l');
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

    // Coalesce ResizeObserver callbacks into one fit per frame. Without this,
    // a divider drag or sidebar toggle fires many ticks, each triggering a
    // full xterm measure+render pass.
    let roRaf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (roRaf !== null) return;
      roRaf = requestAnimationFrame(() => {
        roRaf = null;
        if (safeFit() && interactive) shell.resize(term.cols, term.rows);
      });
    });
    ro.observe(host);

    // The server sends the full log replay in a single WebSocket message
    // on connect. Chunk it so a multi-megabyte initial payload doesn't
    // freeze the parser.
    const unsubBytes = shell.onBytes((data) => writeChunked(data));
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
      if (roRaf !== null) cancelAnimationFrame(roRaf);
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
