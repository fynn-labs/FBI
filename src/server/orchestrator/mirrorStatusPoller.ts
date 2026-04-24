import fs from 'node:fs';
import { parseMirrorStatus } from './mirrorStatus.js';
import type { MirrorStatus } from '../../shared/types.js';

export interface MirrorStatusPollerOptions {
  path: string;
  pollMs?: number;
  onChange: (s: MirrorStatus) => void;
}

export class MirrorStatusPoller {
  private timer: NodeJS.Timeout | null = null;
  private last: MirrorStatus = null;

  constructor(private opts: MirrorStatusPollerOptions) {}

  start(): void {
    const tick = (): void => {
      let raw = '';
      try { raw = fs.readFileSync(this.opts.path, 'utf8'); } catch { /* absent */ }
      const cur = parseMirrorStatus(raw);
      if (cur !== this.last) {
        this.last = cur;
        this.opts.onChange(cur);
      }
      this.timer = setTimeout(tick, this.opts.pollMs ?? 1000);
    };
    tick();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
