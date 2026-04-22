import { stripAnsi } from './resumeDetector.js';
import { sumJsonlSizes } from './mountActivity.js';
import { containsWaitingPrompt } from './waitingPrompt.js';

export interface WaitingMonitorOptions {
  /** Dir to watch for Claude Code's session JSONL writes (activity signal). */
  mountDir: string;
  /** Rolling ANSI-stripped TTY buffer size, in bytes. */
  logBufferBytes?: number;
  /** Required idle time on mount dir before declaring waiting. */
  idleMs?: number;
  /** Absolute warmup after start() before firing is allowed. */
  warmupMs?: number;
  /** Check cadence. */
  checkMs?: number;
  onEnter: () => void;
  onExit: () => void;
  now?: () => number;
}

/**
 * Watches the container's TTY stream + Claude's session JSONL activity to
 * detect when the run has idled at the TUI input prompt (→ onEnter), and
 * when it resumes work (→ onExit). Fused two-signal design mirrors
 * LimitMonitor so the same mental model applies to both detectors.
 */
export class WaitingMonitor {
  private buf = '';
  private startedAt = 0;
  private lastActivityAt = 0;
  private lastTotalSize = 0;
  private inWaiting = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly logBufferBytes: number;
  private readonly idleMs: number;
  private readonly warmupMs: number;
  private readonly checkMs: number;
  private readonly now: () => number;

  constructor(private opts: WaitingMonitorOptions) {
    this.logBufferBytes = opts.logBufferBytes ?? 16 * 1024;
    this.idleMs = opts.idleMs ?? 8_000;
    this.warmupMs = opts.warmupMs ?? 20_000;
    this.checkMs = opts.checkMs ?? 2_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    this.lastTotalSize = sumJsonlSizes(this.opts.mountDir);
    const tick = () => {
      if (!this.timer) return;
      try { this.check(); } catch { /* best-effort */ }
      this.timer = setTimeout(tick, this.checkMs);
    };
    this.timer = setTimeout(tick, this.checkMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  feedLog(chunk: Uint8Array): void {
    const text = Buffer.from(chunk).toString('utf8');
    const stripped = stripAnsi(text);
    if (stripped.length === 0) return;
    this.buf = (this.buf + stripped).slice(-this.logBufferBytes);
  }

  checkNow(): void { this.check(); }

  private check(): void {
    const now = this.now();
    const size = sumJsonlSizes(this.opts.mountDir);
    const grew = size > this.lastTotalSize;
    if (grew) {
      this.lastActivityAt = now;
      this.lastTotalSize = size;
      if (this.inWaiting) {
        this.inWaiting = false;
        this.buf = '';                // reset TTY tail: the prior prompt is stale
        this.opts.onExit();
      }
      return;
    }

    if (this.inWaiting) return;                       // already waiting; nothing to do
    if (now - this.startedAt < this.warmupMs) return;
    if (now - this.lastActivityAt < this.idleMs) return;
    if (!containsWaitingPrompt(this.buf)) return;

    this.inWaiting = true;
    this.opts.onEnter();
  }
}
