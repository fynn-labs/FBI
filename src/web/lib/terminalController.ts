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
  FilesPayload,
} from '@shared/types.js';

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

  // Fires once after the first snapshot is written to xterm (cached or
  // from the server). Consumers use this to drop a "Loading…" overlay
  // without flashing fast-forward content while the opening snapshot is
  // being parsed.
  private ready = false;
  private readyCbs: Array<() => void> = [];

  constructor(runId: number, term: Xterm, host: HTMLElement) {
    this.runId = runId;
    this.term = term;
    this.host = host;
    this.shell = acquireShell(runId);
    traceRecord('controller.mount', { runId });

    this.unsubEvents = this.shell.onTypedEvent<{ type: string; snapshot?: unknown }>((msg) => {
      if (this.disposed) return;
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'state') publishState(runId, msg as unknown as RunWsStateMessage);
      else if (msg.type === 'title') publishTitle(runId, msg as unknown as RunWsTitleMessage);
      else if (msg.type === 'files') publishFiles(runId, msg as unknown as FilesPayload);
    });

    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      this.term.reset();
      this.term.write(snap.ansi, () => { this.fireReady(); });
    });

    this.unsubBytes = this.shell.onBytes((data) => {
      if (this.disposed) return;
      this.term.write(data);
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
      this.term.write(cached.ansi, () => { this.fireReady(); });
    }

    this.unsubOpen = this.shell.onOpen(() => {
      if (this.disposed) return;
      traceRecord('controller.hello', { cols: this.term.cols, rows: this.term.rows });
      this.shell.sendHello(this.term.cols, this.term.rows);
    });
  }

  setInteractive(on: boolean): void {
    if (this.disposed) return;
    if (on && !this.inputDisposable) {
      this.inputDisposable = this.term.onData((d) => {
        traceRecord('controller.input', strPreview(d));
        this.shell.send(new TextEncoder().encode(d));
      });
      this.hostClickHandler = () => this.term.focus();
      this.host.addEventListener('click', this.hostClickHandler);
      this.term.focus();
    } else if (!on && this.inputDisposable) {
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

  private fireReady(): void {
    if (this.ready) return;
    this.ready = true;
    const cbs = this.readyCbs.splice(0);
    for (const cb of cbs) cb();
  }

  /**
   * Re-ask the server for a fresh snapshot by re-sending hello. The server
   * processes hellos idempotently — it drains the parser, re-serializes, and
   * sends a new snapshot frame. Used by the page-visibility handler so a
   * tab-return captures Claude Code's *current* cursor cell rather than
   * whatever was last in the buffer (Claude only draws its cursor cell at
   * specific render moments, and those can happen while the tab is hidden
   * and rAF is throttled).
   */
  requestSnapshot(): void {
    if (this.disposed) return;
    traceRecord('controller.hello', { cols: this.term.cols, rows: this.term.rows });
    this.shell.sendHello(this.term.cols, this.term.rows);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    traceRecord('controller.dispose', { runId: this.runId });
    this.setInteractive(false);
    this.unsubBytes?.(); this.unsubBytes = null;
    this.unsubSnapshot?.(); this.unsubSnapshot = null;
    this.unsubOpen?.(); this.unsubOpen = null;
    this.unsubEvents?.(); this.unsubEvents = null;
    if (this.historyTerm) { this.historyTerm.dispose(); this.historyTerm = null; }
    releaseShell(this.runId);
  }
}
