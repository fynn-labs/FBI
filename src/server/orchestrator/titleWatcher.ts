import fs from 'node:fs';

export interface TitleWatcherOptions {
  path: string;
  pollMs?: number;
  onTitle: (title: string) => void;
  onError: (reason: string) => void;
}

export class TitleWatcher {
  private opts: Required<Omit<TitleWatcherOptions, 'onTitle' | 'onError'>> & TitleWatcherOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastEmitted: string | null = null;

  constructor(opts: TitleWatcherOptions) {
    this.opts = { pollMs: 1000, ...opts };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      try { this.readOnce(); } catch (e) { this.opts.onError(String(e)); }
      this.timer = setTimeout(tick, this.opts.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.readOnce(); } catch (e) { this.opts.onError(String(e)); }
  }

  private readOnce(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.opts.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;  // forwarded to onError by tick-level catch
    }
    const trimmed = raw.trim().slice(0, 80);
    if (trimmed.length === 0) return;
    if (trimmed === this.lastEmitted) return;
    this.lastEmitted = trimmed;
    this.opts.onTitle(trimmed);
  }
}
