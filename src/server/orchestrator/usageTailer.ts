import fs from 'node:fs';
import path from 'node:path';
import { parseUsageLine, parseRateLimitHeaders } from '../../shared/usage.js';
import type { UsageSnapshot, RateLimitSnapshot } from '../../shared/types.js';

export interface UsageTailerOptions {
  dir: string;          // host-side path bind-mounted into /home/agent/.claude/projects
  pollMs?: number;      // poll interval for scanning + reading
  onUsage: (s: UsageSnapshot) => void;
  onRateLimit: (s: RateLimitSnapshot) => void;
  onError: (reason: string) => void;
}

export class UsageTailer {
  private opts: Required<Omit<UsageTailerOptions, 'onUsage' | 'onRateLimit' | 'onError'>> & UsageTailerOptions;
  private offsets = new Map<string, number>();  // file path → bytes read
  private pending = new Map<string, string>();  // file path → partial trailing line
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: UsageTailerOptions) {
    this.opts = { pollMs: 500, ...opts };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      try { this.scanAndRead(); } catch (e) { this.opts.onError(String(e)); }
      this.timer = setTimeout(tick, this.opts.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // Final full pass.
    try { this.scanAndRead(); } catch (e) { this.opts.onError(String(e)); }
  }

  private scanAndRead(): void {
    const files = this.findJsonlFiles(this.opts.dir);
    for (const file of files) {
      this.readNewLines(file);
    }
  }

  private findJsonlFiles(root: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
      const full = path.join(root, e.name);
      if (e.isDirectory()) { out.push(...this.findJsonlFiles(full)); continue; }
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
  }

  private readNewLines(file: string): void {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return; }
    const lastOffset = this.offsets.get(file) ?? 0;
    if (stat.size <= lastOffset) return;

    const fd = fs.openSync(file, 'r');
    try {
      const len = stat.size - lastOffset;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, lastOffset);
      const chunk = (this.pending.get(file) ?? '') + buf.toString('utf8');
      const lastNl = chunk.lastIndexOf('\n');
      const complete = lastNl >= 0 ? chunk.slice(0, lastNl) : '';
      const partial = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;
      this.pending.set(file, partial);
      this.offsets.set(file, stat.size);

      if (complete.length > 0) {
        for (const line of complete.split('\n')) this.processLine(line);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const u = parseUsageLine(trimmed);
    if (u.kind === 'ok') this.opts.onUsage(u.value);
    else if (u.kind === 'error') this.opts.onError(u.reason);

    // Rate-limit parsing operates on the full JSON object; decode once more.
    try {
      const obj = JSON.parse(trimmed);
      const rl = parseRateLimitHeaders(obj);
      if (rl.kind === 'ok') this.opts.onRateLimit(rl.value);
    } catch { /* already reported via parseUsageLine */ }
  }
}
