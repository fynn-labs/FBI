import type { Terminal as Xterm } from '@xterm/xterm';
import { acquireShell, releaseShell, getLastSnapshot } from './shellRegistry.js';
import { publishUsage, publishState, publishTitle, publishChanges } from '../features/runs/usageBus.js';
import { record as traceRecord, strPreview } from './terminalTrace.js';
import type { ShellHandle } from './ws.js';
import type {
  UsageSnapshot,
  RunWsStateMessage,
  RunWsTitleMessage,
  ChangesPayload,
  RunWsSnapshotMessage,
  RunState,
} from '@shared/types.js';

const CHUNK_SIZE = 512 * 1024;
const RESUME_SNAPSHOT_TIMEOUT_MS = 2000;

export type ChunkLoadState = 'idle' | 'loading' | 'error';

function isLiveState(s: RunState): boolean {
  return s === 'queued' || s === 'starting' || s === 'running' || s === 'waiting' || s === 'awaiting_resume';
}

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
 * the pause/resume state machine for lazy scrollback. The React component
 * owns the xterm instance and the JSX host element; the controller owns
 * every side-effect of "user looks at a run" — shell acquire/release,
 * typed-event routing, snapshot application, input wiring, scroll-driven
 * pause/resume, and older-chunk prefetch.
 *
 * Constructor takes a `host` element (the xterm's host div). Focus and
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

  // Hard lifecycle flag. Once true, all callbacks become no-ops and the
  // class is unusable; monotonic.
  private disposed = false;

  private liveTailBytes: Uint8Array = new Uint8Array();
  private liveOffset = 0;
  private latestState: RunState = 'queued';
  private loadedBytes: Uint8Array = new Uint8Array();
  private loadedStartOffset = 0;
  private paused = false;
  private rebuilding = false;
  private seeded = false;
  private pendingChunk: { abort: AbortController; promise: Promise<void> } | null = null;
  private pendingResumeSnapshot: ((snap: RunWsSnapshotMessage) => void) | null = null;
  private pendingResumePromise: Promise<void> | null = null;
  private startMarkerWritten = false;
  private pauseListeners = new Set<(paused: boolean) => void>();
  private chunkState: ChunkLoadState = 'idle';
  private chunkStateListeners = new Set<(s: ChunkLoadState) => void>();
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
      else if (msg.type === 'changes') publishChanges(runId, msg as unknown as ChangesPayload);
    });

    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      // Resume interception: if a resume is waiting for a fresh snapshot,
      // hand it over and skip the normal reset+write (resume does its own
      // rebuild with scrollback preserved).
      if (this.pendingResumeSnapshot) {
        const resolve = this.pendingResumeSnapshot;
        this.pendingResumeSnapshot = null;
        resolve(snap);
        return;
      }
      // Drop snapshots while paused — they would term.reset() and wipe
      // the scrollback the user is actively reading. On resume, we'll
      // request a fresh snapshot via sendHello.
      if (this.paused) {
        traceRecord('controller.snapshot.dropped', { reason: 'paused' });
        return;
      }
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
      // Drop while paused OR rebuilding: no xterm write, no liveTailBytes append.
      // Paused blocks user-visible live updates; rebuilding blocks recursive
      // writes from an onBytes handler firing mid-rebuild (which would race
      // with rebuildXterm's own writes and double-write the same bytes).
      if (this.paused || this.rebuilding) return;
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

  onPauseChange(cb: (paused: boolean) => void): () => void {
    this.pauseListeners.add(cb);
    return () => { this.pauseListeners.delete(cb); };
  }

  onChunkStateChange(cb: (s: ChunkLoadState) => void): () => void {
    this.chunkStateListeners.add(cb);
    return () => { this.chunkStateListeners.delete(cb); };
  }

  private setChunkState(s: ChunkLoadState): void {
    if (this.chunkState === s) return;
    this.chunkState = s;
    // Snapshot + per-listener try/catch matches the pauseListeners pattern.
    const snap = [...this.chunkStateListeners];
    for (const cb of snap) {
      try { cb(s); } catch (err) {
        traceRecord('controller.chunk.listener.error', { err: String(err) });
      }
    }
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
    // Each pause session starts with a clean chunk slate — clear any
    // stale error state from a prior paused session.
    this.setChunkState('idle');
    this.paused = true;
    this.applyInteractive();
    this.emitPauseChange();
  }

  /**
   * Called by the React component on every xterm scroll event.
   * - atBottom + paused → auto-resume.
   * - not atBottom + not paused → pause.
   * - nearTop + paused + startOffset > 0 → prefetch next chunk.
   */
  onScroll(s: { atBottom: boolean; nearTop: boolean }): void {
    if (this.disposed || this.rebuilding) return;
    if (!this.paused && !s.atBottom) {
      this.pause();
      return;
    }
    if (this.paused && s.atBottom) {
      void this.resume();
      return;
    }
    if (this.paused && s.nearTop && this.loadedStartOffset > 0 && !this.pendingChunk) {
      void this.loadOlderChunk();
    }
  }

  async resume(): Promise<void> {
    if (this.disposed || !this.paused) return;
    if (this.pendingResumePromise) return this.pendingResumePromise;
    traceRecord('controller.resume', { runId: this.runId, state: this.latestState });

    this.pendingResumePromise = (async () => {
      try {
        // Abort a concurrent chunk load; its rebuild would be wasted work.
        if (this.pendingChunk) {
          this.pendingChunk.abort.abort();
          this.pendingChunk = null;
        }

        let freshSnap: RunWsSnapshotMessage | null = null;
        if (isLiveState(this.latestState)) {
          const p = new Promise<RunWsSnapshotMessage>((resolve) => {
            this.pendingResumeSnapshot = resolve;
          });
          const timeout = new Promise<null>((r) => setTimeout(() => r(null), RESUME_SNAPSHOT_TIMEOUT_MS));
          this.shell.sendHello(this.term.cols, this.term.rows);
          const snap = await Promise.race([p, timeout]);
          if (snap) {
            freshSnap = snap;
            this.pendingResumeSnapshot = null;
          } else {
            // Timeout: swap the resolver for a no-op sink. A late snapshot
            // will be handed to the sink by the interception branch and
            // discarded — crucially NOT routed through the normal
            // reset+write path, which would wipe the scrollback we're
            // about to rebuild via the tail-fetch fallback.
            this.pendingResumeSnapshot = () => { /* swallow late snapshot */ };
          }
        }

        let tail: Uint8Array | null = null;
        if (!freshSnap) {
          try {
            const res = await fetch(`/api/runs/${this.runId}/transcript`, {
              headers: { Range: `bytes=${this.liveOffset}-` },
            });
            if (!this.disposed && (res.ok || res.status === 206)) {
              tail = new Uint8Array(await res.arrayBuffer());
              if (tail.byteLength > 0) {
                const mergedLive = concat([this.liveTailBytes, tail]);
                this.liveTailBytes = mergedLive;
                this.liveOffset += tail.byteLength;
              }
            }
          } catch (err) {
            traceRecord('controller.resume.tail.error', { err: String(err) });
          }
        }

        if (this.disposed) return;

        const buffers: Array<Uint8Array | string> = [this.loadedBytes, this.liveTailBytes];
        if (freshSnap) buffers.push(freshSnap.ansi);
        await this.rebuildXterm(buffers);

        if (this.disposed) return;
        this.term.scrollToBottom();
        this.scheduleCursorRedraw();
        this.paused = false;
        this.applyInteractive();
        this.emitPauseChange();
      } finally {
        this.pendingResumePromise = null;
      }
    })();
    return this.pendingResumePromise;
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
      // Gate onBytes and onScroll during the rebuild so live WS bytes
      // aren't double-written and xterm's transient scroll events
      // (term.reset(), write() autoscroll) don't trigger spurious
      // pause/resume/loadOlderChunk dispatches. Distinct from `paused`:
      // the user never paused — this is a purely internal reentrancy
      // guard that must not fire `emitPauseChange` or affect the banner.
      this.rebuilding = true;
      try {
        await this.rebuildXterm([this.loadedBytes, this.liveTailBytes]);
        this.term.scrollToBottom();
      } finally {
        this.rebuilding = false;
      }
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

  /**
   * Fetch the next CHUNK_SIZE bytes of older transcript (bytes before
   * loadedStartOffset) and rebuild the xterm with scroll position
   * restored.
   *
   * Guards:
   * - Must be paused (no-op otherwise).
   * - loadedStartOffset === 0 → no-op.
   * - pendingChunk !== null → returns the in-flight promise (dedup).
   */
  async loadOlderChunk(): Promise<void> {
    if (this.disposed || !this.paused) return;
    if (this.loadedStartOffset === 0) return;
    if (this.pendingChunk) return this.pendingChunk.promise;

    // Caller must be paused (we early-return if not). The pause gate in
    // onBytes keeps live WS bytes from being written to xterm during the
    // rebuild, preventing the double-write race that Task 7's seed path
    // handles with its own local pause bracket.
    const abort = new AbortController();
    const end = this.loadedStartOffset - 1;
    const start = Math.max(0, this.loadedStartOffset - CHUNK_SIZE);
    traceRecord('controller.chunk.fetch', { runId: this.runId, start, end });

    const promise = (async () => {
      this.setChunkState('loading');
      try {
        const res = await fetch(`/api/runs/${this.runId}/transcript`, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: abort.signal,
        });
        if (this.disposed) return;
        if (abort.signal.aborted) { this.setChunkState('idle'); return; }
        if (!res.ok && res.status !== 206) {
          this.setChunkState('error');
          traceRecord('controller.chunk.error', { status: res.status });
          return;
        }
        const chunk = new Uint8Array(await res.arrayBuffer());
        if (this.disposed) return;
        if (abort.signal.aborted) { this.setChunkState('idle'); return; }

        const oldBaseY = this.term.buffer.active.baseY;
        const oldViewportY = this.term.buffer.active.viewportY;

        const newLoaded = concat([chunk, this.loadedBytes]);
        await this.rebuildXterm([newLoaded, this.liveTailBytes]);
        if (this.disposed) return;
        if (abort.signal.aborted) { this.setChunkState('idle'); return; }

        const newBaseY = this.term.buffer.active.baseY;
        const addedLines = newBaseY - oldBaseY;
        this.term.scrollToLine(oldViewportY + addedLines);

        this.loadedBytes = newLoaded;
        this.loadedStartOffset = start;
        if (start === 0 && !this.startMarkerWritten) {
          this.startMarkerWritten = true;
          this.term.write(new TextEncoder().encode('\r\n\x1b[2;37m── start of run ──\x1b[0m\r\n'));
        }
        this.setChunkState('idle');
        traceRecord('controller.chunk.rebuild', {
          addedBytes: chunk.byteLength,
          addedLines,
        });
      } catch (err) {
        if (abort.signal.aborted) {
          this.setChunkState('idle'); // aborted by resume — not a user-facing error
          return;
        }
        this.setChunkState('error');
        traceRecord('controller.chunk.error', { err: String(err) });
      } finally {
        this.pendingChunk = null;
      }
    })();

    this.pendingChunk = { abort, promise };
    return promise;
  }

  /** @internal — for tests only. */
  _debugBuffers(): { liveTailBytes: Uint8Array; liveOffset: number; latestState: RunState; loadedBytes: Uint8Array; loadedStartOffset: number; paused: boolean; rebuilding: boolean; chunkState: ChunkLoadState } {
    return {
      liveTailBytes: this.liveTailBytes,
      liveOffset: this.liveOffset,
      latestState: this.latestState,
      loadedBytes: this.loadedBytes,
      loadedStartOffset: this.loadedStartOffset,
      paused: this.paused,
      rebuilding: this.rebuilding,
      chunkState: this.chunkState,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    traceRecord('controller.dispose', { runId: this.runId });
    this.setInteractive(false);
    if (this.pendingChunk) { this.pendingChunk.abort.abort(); this.pendingChunk = null; }
    this.pendingResumeSnapshot = null;
    this.unsubBytes?.(); this.unsubBytes = null;
    this.unsubSnapshot?.(); this.unsubSnapshot = null;
    this.unsubOpen?.(); this.unsubOpen = null;
    this.unsubEvents?.(); this.unsubEvents = null;
    this.pauseListeners.clear();
    this.chunkStateListeners.clear();
    releaseShell(this.runId);
  }
}
