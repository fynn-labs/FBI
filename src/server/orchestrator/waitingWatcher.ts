import fs from 'node:fs';

export interface WaitingWatcherOptions {
  /** Path to the sentinel file written/removed by Claude Code hooks. */
  path: string;
  pollMs?: number;
  onEnter: () => void;
  onExit: () => void;
}

/**
 * Watches a sentinel file whose presence/absence reflects whether Claude Code
 * is waiting at the input prompt. Claude Code's Stop hook creates the file
 * (turn ended) and UserPromptSubmit removes it (user replied). Mirrors the
 * polling style of TitleWatcher so the orchestrator has one consistent
 * file-watcher shape across /fbi-state signals.
 *
 * Transitions fire onEnter/onExit; steady state is silent.
 */
export class WaitingWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  // Start in "not waiting" — matches the orchestrator's default `running` state
  // after container start, so a first poll of an absent sentinel is silent.
  // On reattach to a container already at the prompt, the sentinel is present
  // on first poll and we correctly fire onEnter to sync.
  private lastWaiting = false;
  private readonly pollMs: number;

  constructor(private opts: WaitingWatcherOptions) {
    this.pollMs = opts.pollMs ?? 500;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      try { this.readOnce(); } catch { /* best-effort */ }
      this.timer = setTimeout(tick, this.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Synchronous poll — exposed for tests. */
  checkNow(): void { this.readOnce(); }

  private readOnce(): void {
    const waiting = fs.existsSync(this.opts.path);
    if (this.lastWaiting === waiting) return;
    this.lastWaiting = waiting;
    if (waiting) this.opts.onEnter();
    else this.opts.onExit();
  }
}
