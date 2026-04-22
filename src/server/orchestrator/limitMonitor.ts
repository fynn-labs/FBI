import { containsLimitSignal, stripAnsi } from './resumeDetector.js';
import { sumJsonlSizes } from './mountActivity.js';

export interface LimitMonitorOptions {
  /** Dir to watch for Claude Code's session JSONL writes (activity signal). */
  mountDir: string;
  /** Rolling ANSI-stripped buffer size, in bytes. */
  logBufferBytes?: number;
  /** Required idle time on mount dir before firing. */
  idleMs?: number;
  /** Absolute warmup after `start()` before firing is allowed. */
  warmupMs?: number;
  /** Check cadence. */
  checkMs?: number;
  /** Fired exactly once. */
  onDetect: () => void;
  /** Optional clock injection for tests. */
  now?: () => number;
}

/**
 * Watches the container's TTY stream for a rate-limit message and fires once
 * when Claude is clearly stuck on that message.
 *
 * The detector uses two independent signals to avoid false positives:
 *  1. The rolling ANSI-stripped tail contains a limit phrase.
 *  2. Claude has been idle — no new bytes appended to any session JSONL in
 *     `mountDir` for `idleMs` — AND we're past an absolute `warmupMs` from
 *     start, which is long enough that any prompt echo has scrolled out of
 *     the rolling window on a live run.
 *
 * Both must hold simultaneously. This rules out false positives from user
 * prompts that literally contain "hit your limit …" (they're echoed early,
 * but Claude is making API calls so the mount dir isn't idle).
 */
export class LimitMonitor {
  private buf = '';
  private fired = false;
  private startedAt = 0;
  private lastActivityAt = 0;
  private lastTotalSize = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly logBufferBytes: number;
  private readonly idleMs: number;
  private readonly warmupMs: number;
  private readonly checkMs: number;
  private readonly now: () => number;

  constructor(private opts: LimitMonitorOptions) {
    this.logBufferBytes = opts.logBufferBytes ?? 16 * 1024;
    this.idleMs = opts.idleMs ?? 15_000;
    this.warmupMs = opts.warmupMs ?? 60_000;
    this.checkMs = opts.checkMs ?? 3_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    this.lastTotalSize = this.currentMountSize();
    const tick = () => {
      if (!this.timer) return;
      try { this.check(); } catch { /* swallow — best-effort */ }
      this.timer = setTimeout(tick, this.checkMs);
    };
    this.timer = setTimeout(tick, this.checkMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Feed a chunk of raw TTY bytes (ANSI allowed). Called per attach 'data'. */
  feedLog(chunk: Uint8Array): void {
    if (this.fired) return;
    const text = Buffer.from(chunk).toString('utf8');
    const stripped = stripAnsi(text);
    if (stripped.length === 0) return;
    this.buf = (this.buf + stripped).slice(-this.logBufferBytes);
  }

  /** Force a check now — used by tests. */
  checkNow(): void { this.check(); }

  private check(): void {
    if (this.fired) return;
    const now = this.now();
    // Update activity signal: has any session file grown since last tick?
    const size = this.currentMountSize();
    if (size > this.lastTotalSize) {
      this.lastActivityAt = now;
      this.lastTotalSize = size;
    }
    if (now - this.startedAt < this.warmupMs) return;
    if (now - this.lastActivityAt < this.idleMs) return;
    if (!containsLimitSignal(this.buf)) return;
    this.fired = true;
    this.stop();
    this.opts.onDetect();
  }

  private currentMountSize(): number {
    return sumJsonlSizes(this.opts.mountDir);
  }
}
