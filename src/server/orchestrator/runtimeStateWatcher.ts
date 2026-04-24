import fs from 'node:fs';

export type DerivedRuntimeState = 'starting' | 'running' | 'waiting';

export interface RuntimeStateWatcherOptions {
  /** Path to the sentinel created by Claude Code's Stop hook. */
  waitingPath: string;
  /** Path to the sentinel created by Claude Code's UserPromptSubmit hook. */
  promptedPath: string;
  pollMs?: number;
  /** Fires on first poll AND on every change. */
  onChange: (state: DerivedRuntimeState) => void;
}

/**
 * Polls two sentinel files written by Claude Code hooks and derives a
 * runtime state. Fires `onChange` once on first poll (so reattach picks up
 * the current state) and again on every transition. Steady state is silent.
 *
 *   waiting present                  -> 'waiting'
 *   waiting absent, prompted present -> 'running'
 *   both absent                      -> 'starting'
 */
export class RuntimeStateWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private last: DerivedRuntimeState | null = null;
  private readonly pollMs: number;

  constructor(private opts: RuntimeStateWatcherOptions) {
    this.pollMs = opts.pollMs ?? 500;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Fire the first poll synchronously so callers that immediately call
    // stop() still receive the initial state emission.
    try { this.readOnce(); } catch { /* best-effort */ }
    const tick = () => {
      if (!this.running) return;
      try { this.readOnce(); } catch { /* best-effort */ }
      this.timer = setTimeout(tick, this.pollMs);
    };
    this.timer = setTimeout(tick, this.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Synchronous poll — exposed for tests. */
  checkNow(): void { this.readOnce(); }

  private readOnce(): void {
    const waiting = fs.existsSync(this.opts.waitingPath);
    const prompted = fs.existsSync(this.opts.promptedPath);
    const derived: DerivedRuntimeState = waiting
      ? 'waiting'
      : prompted ? 'running' : 'starting';
    if (this.last === derived) return;
    this.last = derived;
    this.opts.onChange(derived);
  }
}
