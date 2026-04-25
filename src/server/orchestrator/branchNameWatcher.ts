import fs from 'node:fs';

const VALID = /^[a-zA-Z0-9]([a-zA-Z0-9_./-]*[a-zA-Z0-9])?$/;
const MAX_LEN = 100;

export interface BranchNameWatcherOptions {
  path: string;
  pollMs?: number;
  onBranchName: (name: string) => void;
  onError: (reason: string) => void;
}

export class BranchNameWatcher {
  private opts: Required<Omit<BranchNameWatcherOptions, 'onBranchName' | 'onError'>> & BranchNameWatcherOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastEmitted: string | null = null;

  constructor(opts: BranchNameWatcherOptions) {
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
      throw e;
    }
    const name = raw.trim().slice(0, MAX_LEN);
    if (!name || !VALID.test(name)) return;
    if (name === this.lastEmitted) return;
    this.lastEmitted = name;
    this.opts.onBranchName(name);
  }
}
