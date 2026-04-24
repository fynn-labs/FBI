import type { Terminal as Xterm } from '@xterm/xterm';
import { Terminal as XtermImpl } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { acquireShell, releaseShell, getLastSnapshot } from './shellRegistry.js';
import { publishUsage, publishState, publishTitle, publishFiles } from '../features/runs/usageBus.js';
import { record as traceRecord, strPreview } from './terminalTrace.js';
import type { ShellHandle } from './ws.js';
import type {
  UsageSnapshot,
  RunWsStateMessage,
  RunWsTitleMessage,
  RunWsSnapshotMessage,
  FilesPayload,
  RunState,
} from '@shared/types.js';

const CHUNK_SIZE = 512 * 1024;

function concat(bufs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const b of bufs) total += b.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { out.set(b, off); off += b.byteLength; }
  return out;
}

/**
 * Owns the terminal's WebSocket lifecycle, the snapshot/bytes plumbing, and
 * the live/history switch. The React component owns the *live* xterm
 * instance and the JSX host elements; the controller owns the transient
 * history xterm it creates in `enterHistory()`. Every side-effect of "user
 * looks at a run" — shell acquire/release, typed-event routing, snapshot
 * application, input wiring — lives in the controller.
 *
 * Constructor takes a `host` element (the live xterm's host div). Focus and
 * click-to-focus are wired here so `setInteractive(false)` can cleanly tear
 * them down without React having to know.
 */
export class TerminalController {
  private readonly runId: number;
  private readonly term: Xterm;
  private readonly host: HTMLElement;
  private readonly shell: ShellHandle;

  private unsubBytes: (() => void) | null = null;
  private unsubSnapshot: (() => void) | null = null;
  private unsubOpen: (() => void) | null = null;
  private unsubEvents: (() => void) | null = null;

  private inputDisposable: { dispose(): void } | null = null;
  private hostClickHandler: (() => void) | null = null;

  // History xterm created lazily in enterHistory(); lifetime = enterHistory → resumeLive/dispose.
  private historyTerm: Xterm | null = null;
  // Soft cancel for an in-flight history fetch/stream. Independent of
  // `disposed` (which is the hard lifecycle flag for the whole controller).
  // Flipped true on resumeLive/dispose; reset to false in enterHistory.
  private historyAborted = false;

  // Hard lifecycle flag. Once true, all callbacks become no-ops and the
  // class is unusable; monotonic.
  private disposed = false;

  private liveTailBytes: Uint8Array = new Uint8Array();
  private liveOffset = 0;
  private latestState: RunState = 'queued';
  private loadedBytes: Uint8Array = new Uint8Array();
  private loadedStartOffset = 0;
  private paused = false;
  private seeded = false;
  private pauseListeners = new Set<(paused: boolean) => void>();
  private interactiveProp = false; // track the prop so applyInteractive can recompute

  // Fires once after the first snapshot is written to xterm AND the
  // byte stream has settled (or after a hard cap). Consumers use this to
  // drop a "Loading…" overlay without flashing fast-forward content while
  // Claude's post-snapshot redraw bytes are flushing in.
  private ready = false;
  private readyCbs: Array<() => void> = [];
  private readySilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readyCapTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotArrived = false;

  constructor(runId: number, term: Xterm, host: HTMLElement) {
    this.runId = runId;
    this.term = term;
    this.host = host;
    this.shell = acquireShell(runId);
    traceRecord('controller.mount', { runId });

    this.unsubEvents = this.shell.onTypedEvent<{ type: string; snapshot?: unknown; state?: RunState }>((msg) => {
      if (this.disposed) return;
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'state') {
        if (msg.state) this.latestState = msg.state;
        publishState(runId, msg as unknown as RunWsStateMessage);
      }
      else if (msg.type === 'title') publishTitle(runId, msg as unknown as RunWsTitleMessage);
      else if (msg.type === 'files') publishFiles(runId, msg as unknown as FilesPayload);
    });

    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      this.term.reset();
      this.term.write(snap.ansi);
      // Kick off the byte-silence timer synchronously. xterm's write-complete
      // callback is unreliable here (term.reset() appears to drop pending
      // callbacks), and we only need this to *start* a settling window —
      // exact "parsed" timing doesn't matter.
      this.onSnapshotParsed();
      // Each snapshot (initial AND reconnect-served) gets a deferred redraw
      // nudge so Claude paints its cursor cell — its first redraw frame
      // sometimes omits it. This matters most on WS reconnect after a
      // container restart, where the first snapshot lands without cursor.
      this.scheduleCursorRedraw();
      if (!this.seeded) {
        this.seeded = true;
        // Defer to a microtask so synchronous subscribers (tests, or any
        // callers that register handlers and then set up fetch stubs)
        // run to completion before the first Range request fires.
        queueMicrotask(() => { void this.seedInitialHistory(snap); });
      }
    });

    this.unsubBytes = this.shell.onBytes((data) => {
      if (this.disposed) return;
      if (this.paused) return; // drop while paused — no xterm write, no liveTailBytes append
      this.term.write(data);
      // Retain the live tail so pause/chunk-load/resume rebuilds can replay
      // it. Grows unbounded by design — see spec Q8 (no cap in v1).
      const next = new Uint8Array(this.liveTailBytes.byteLength + data.byteLength);
      next.set(this.liveTailBytes);
      next.set(data, this.liveTailBytes.byteLength);
      this.liveTailBytes = next;
      this.liveOffset += data.byteLength;
      // Reset the byte-silence timer on every byte arrival. Ready fires
      // when the stream has been quiet for a short window after the
      // snapshot has been parsed.
      this.bumpReadySilenceTimer();
    });

    // Apply any cached snapshot synchronously so a quick remount shows
    // something immediately. Relies on the Task 3 server contract: every
    // onOpen below triggers a hello, which the server answers with a fresh
    // snapshot — so even if the cached value is stale (dims, content), the
    // follow-up onSnapshot handler above will reset+write over it.
    const cached = getLastSnapshot(runId);
    if (cached) {
      traceRecord('controller.snapshot.cached', { cols: cached.cols, rows: cached.rows });
      this.term.reset();
      this.term.write(cached.ansi);
      // Cache-hit fast path: the user already saw this run's screen; the
      // cached snapshot is a reasonable stand-in while we wait for the
      // fresh one. Fire ready synchronously so the "Loading terminal…"
      // overlay never appears on repeat visits.
      this.snapshotArrived = true;
      this.ready = true;
    }

    this.unsubOpen = this.shell.onOpen(() => {
      if (this.disposed) return;
      traceRecord('controller.hello', { cols: this.term.cols, rows: this.term.rows });
      this.shell.sendHello(this.term.cols, this.term.rows);
    });
  }

  setInteractive(on: boolean): void {
    if (this.disposed) return;
    this.interactiveProp = on;
    this.applyInteractive();
  }

  private applyInteractive(): void {
    if (this.disposed) return;
    const effective = this.interactiveProp && !this.paused;
    if (effective && !this.inputDisposable) {
      this.inputDisposable = this.term.onData((d) => {
        traceRecord('controller.input', strPreview(d));
        this.shell.send(new TextEncoder().encode(d));
      });
      this.hostClickHandler = () => this.term.focus();
      this.host.addEventListener('click', this.hostClickHandler);
      this.term.focus();
    } else if (!effective && this.inputDisposable) {
      this.inputDisposable.dispose();
      this.inputDisposable = null;
      if (this.hostClickHandler) {
        this.host.removeEventListener('click', this.hostClickHandler);
        this.hostClickHandler = null;
      }
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.shell.resize(cols, rows);
  }

  /**
   * Subscribe to the one-shot "ready" signal that fires after the first
   * snapshot has been written to xterm (cached or from the server). If the
   * snapshot already landed before subscription, fires on the next microtask.
   */
  onReady(cb: () => void): void {
    if (this.ready) { queueMicrotask(cb); return; }
    this.readyCbs.push(cb);
  }

  // Called when a snapshot has been parsed into xterm. Starts the byte-
  // silence watch + hard cap on first snapshot only: ready fires after
  // 400 ms of no bytes, or after 2000 ms as a hard cap (so a perpetually-
  // chatty terminal still reveals itself eventually). The cursor-redraw
  // nudge is scheduled separately on every snapshot — see scheduleCursorRedraw.
  private onSnapshotParsed(): void {
    if (this.snapshotArrived) return;
    this.snapshotArrived = true;
    this.bumpReadySilenceTimer();
    this.readyCapTimer = setTimeout(() => this.fireReady(), 2000);
  }

  // Deferred redraw nudge: Claude Code sometimes omits its prompt-cursor
  // cell on a SIGWINCH redraw (depending on which render phase the TUI is
  // in). A deferred requestRedraw 800ms after each snapshot asks Claude
  // to paint one more full frame, catching the cursor. Runs on every
  // snapshot (initial AND reconnect) so a container-restart reattach
  // also gets the cursor back.
  private scheduleCursorRedraw(): void {
    setTimeout(() => {
      if (!this.disposed) this.requestRedraw();
    }, 800);
  }

  /** Whether the first snapshot (cached or fresh) has been applied. */
  isReady(): boolean {
    return this.ready;
  }

  private bumpReadySilenceTimer(): void {
    if (this.ready || !this.snapshotArrived) return;
    if (this.readySilenceTimer) clearTimeout(this.readySilenceTimer);
    this.readySilenceTimer = setTimeout(() => this.fireReady(), 400);
  }

  private fireReady(): void {
    if (this.ready) return;
    this.ready = true;
    if (this.readySilenceTimer) { clearTimeout(this.readySilenceTimer); this.readySilenceTimer = null; }
    if (this.readyCapTimer) { clearTimeout(this.readyCapTimer); this.readyCapTimer = null; }
    const cbs = this.readyCbs.splice(0);
    for (const cb of cbs) cb();
  }

  /**
   * Nudge Claude to repaint and re-sync the xterm buffer to the server's
   * current screen. Used by the page-visibility handler so tab-return
   * behaves like a page refresh (cursor cell and all).
   *
   * Page-refresh works because the fresh xterm is created at 80×24, then
   * fit.fit() resizes to the real viewport — two real dim changes, two
   * SIGWINCHes, two Claude redraws. A visibility return has stable dims,
   * so a re-hello alone often doesn't trigger a fresh Claude redraw.
   *
   * This method forces a redraw by briefly perturbing the PTY size by one
   * row on the server, then restoring it 40 ms later. Both resizes reach
   * Claude as SIGWINCH, Claude redraws the viewport (including its cursor
   * cell), redraw bytes flow to the client. The +1/−1 perturbation is
   * invisible because xterm's own cols/rows never change; only the
   * server's PTY dims do, and the overlap is under one frame.
   */
  requestRedraw(): void {
    if (this.disposed) return;
    const { cols, rows } = this.term;
    traceRecord('controller.redraw', { cols, rows });
    this.shell.resize(cols, rows + 1);
    setTimeout(() => {
      if (this.disposed) return;
      this.shell.resize(cols, rows);
    }, 40);
  }

  async enterHistory(historyHost: HTMLElement): Promise<void> {
    if (this.disposed) return;
    traceRecord('controller.history.start', { runId: this.runId });
    this.historyAborted = false;
    if (this.historyTerm) { this.historyTerm.dispose(); this.historyTerm = null; }

    this.historyTerm = new XtermImpl({
      convertEol: true,
      fontFamily: this.term.options.fontFamily ?? 'ui-monospace, monospace',
      fontSize: this.term.options.fontSize ?? 13,
      theme: this.term.options.theme,
      cursorBlink: false,
      disableStdin: true,
    });
    const fit = new FitAddon();
    this.historyTerm.loadAddon(fit);
    this.historyTerm.open(historyHost);
    try { fit.fit(); } catch { /* ignore */ }

    try {
      const res = await fetch(`/api/runs/${this.runId}/transcript`);
      if (this.disposed || this.historyAborted) return;
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (this.disposed || this.historyAborted) return;
      const CHUNK = 1024 * 1024;
      for (let off = 0; off < buf.byteLength; off += CHUNK) {
        if (this.disposed || this.historyAborted || !this.historyTerm) return;
        const end = Math.min(off + CHUNK, buf.byteLength);
        await new Promise<void>((resolve) =>
          this.historyTerm!.write(buf.subarray(off, end), resolve),
        );
      }
      traceRecord('controller.history.end', { runId: this.runId, bytes: buf.byteLength });
    } catch {
      if (this.disposed || this.historyAborted || !this.historyTerm) return;
      this.historyTerm.write(new TextEncoder().encode('\r\n[failed to load history]\r\n'));
      traceRecord('controller.history.end', { runId: this.runId, error: true });
    }
  }

  resumeLive(): void {
    if (this.disposed) return;
    this.historyAborted = true;
    if (this.historyTerm) { this.historyTerm.dispose(); this.historyTerm = null; }
    this.term.focus();
    traceRecord('controller.resumeLive', { runId: this.runId });
  }

  onPauseChange(cb: (paused: boolean) => void): () => void {
    this.pauseListeners.add(cb);
    return () => { this.pauseListeners.delete(cb); };
  }

  private emitPauseChange(): void {
    // Snapshot the set so a listener that unsubscribes itself during emit
    // doesn't disturb iteration. Errors in one listener don't skip later ones.
    const snap = [...this.pauseListeners];
    for (const cb of snap) {
      try { cb(this.paused); } catch (err) {
        traceRecord('controller.pause.listener.error', { err: String(err) });
      }
    }
  }

  pause(): void {
    if (this.disposed || this.paused) return;
    traceRecord('controller.pause', { runId: this.runId });
    this.paused = true;
    this.applyInteractive();
    this.emitPauseChange();
  }

  private writeAndWait(data: Uint8Array | string): Promise<void> {
    return new Promise<void>((resolve) => this.term.write(data, resolve));
  }

  /**
   * Reset xterm and replay a sequence of byte buffers. Returns after all
   * writes have been acknowledged by xterm's parser.
   */
  private async rebuildXterm(buffers: Array<Uint8Array | string>): Promise<void> {
    this.term.reset();
    for (const b of buffers) {
      await this.writeAndWait(b);
    }
  }

  /**
   * Fetch the last CHUNK_SIZE bytes of the transcript and rebuild the
   * xterm with [seed, snapshot]. Called once on mount, after the initial
   * snapshot has been written to xterm by the normal handler.
   *
   * Stores seed+snapshot bytes in `loadedBytes`. On total < CHUNK_SIZE,
   * fetches from byte 0 (i.e., the full transcript so far).
   */
  private async seedInitialHistory(snap: RunWsSnapshotMessage): Promise<void> {
    try {
      const snapBytes = new TextEncoder().encode(snap.ansi);
      const headerTotal = await this.fetchTranscriptMeta();
      if (headerTotal === 0) {
        this.loadedBytes = snapBytes;
        this.loadedStartOffset = 0;
        this.liveOffset = 0;
        traceRecord('controller.seed.complete', { bytes: 0 });
        return;
      }
      const start = Math.max(0, headerTotal - CHUNK_SIZE);
      const end = headerTotal - 1;
      const res = await fetch(`/api/runs/${this.runId}/transcript`, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (this.disposed) return;
      if (!res.ok && res.status !== 206) {
        traceRecord('controller.seed.error', { status: res.status });
        return;
      }
      const seedBytes = new Uint8Array(await res.arrayBuffer());
      if (this.disposed) return;
      this.loadedBytes = concat([seedBytes, snapBytes]);
      this.loadedStartOffset = start;
      this.liveOffset = headerTotal;
      // Include liveTailBytes in case any live bytes arrived between the
      // initial snapshot (written by the normal handler) and this rebuild.
      await this.rebuildXterm([this.loadedBytes, this.liveTailBytes]);
      this.term.scrollToBottom();
      traceRecord('controller.seed.complete', { bytes: seedBytes.byteLength });
    } catch (err) {
      traceRecord('controller.seed.error', { err: String(err) });
    }
  }

  /** HEAD-less total: make a 1-byte Range request to read X-Transcript-Total. */
  private async fetchTranscriptMeta(): Promise<number> {
    const res = await fetch(`/api/runs/${this.runId}/transcript`, {
      headers: { Range: 'bytes=0-0' },
    });
    if (this.disposed) return 0;
    const total = Number(res.headers.get('X-Transcript-Total') ?? '0');
    return Number.isFinite(total) ? total : 0;
  }

  /** @internal — for tests only. */
  _debugBuffers(): { liveTailBytes: Uint8Array; liveOffset: number; latestState: RunState; loadedBytes: Uint8Array; loadedStartOffset: number; paused: boolean } {
    return {
      liveTailBytes: this.liveTailBytes,
      liveOffset: this.liveOffset,
      latestState: this.latestState,
      loadedBytes: this.loadedBytes,
      loadedStartOffset: this.loadedStartOffset,
      paused: this.paused,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    traceRecord('controller.dispose', { runId: this.runId });
    this.setInteractive(false);
    this.unsubBytes?.(); this.unsubBytes = null;
    this.unsubSnapshot?.(); this.unsubSnapshot = null;
    this.unsubOpen?.(); this.unsubOpen = null;
    this.unsubEvents?.(); this.unsubEvents = null;
    this.pauseListeners.clear();
    if (this.historyTerm) { this.historyTerm.dispose(); this.historyTerm = null; }
    releaseShell(this.runId);
  }
}
