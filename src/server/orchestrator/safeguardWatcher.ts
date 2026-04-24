import fs from 'node:fs';
import path from 'node:path';
import { SafeguardRepo } from './safeguardRepo.js';
import type { FilesPayload } from '../../shared/types.js';

export interface SafeguardWatcherOptions {
  bareDir: string;
  branch: string;
  onSnapshot: (s: FilesPayload) => void;
  onError?: (reason: string) => void;
}

export class SafeguardWatcher {
  private watcher: fs.FSWatcher | null = null;
  private packedWatcher: fs.FSWatcher | null = null;
  private readonly repo: SafeguardRepo;
  private lastSha: string | null = null;
  private started = false;

  constructor(private readonly opts: SafeguardWatcherOptions) {
    this.repo = new SafeguardRepo(opts.bareDir);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.emit();
    const refDir = path.join(this.opts.bareDir, 'refs', 'heads');
    fs.mkdirSync(refDir, { recursive: true });
    try {
      this.watcher = fs.watch(refDir, { recursive: false }, () => {
        void this.emit();
      });
    } catch (e) {
      this.opts.onError?.(String(e));
    }
    const packedPath = path.join(this.opts.bareDir, 'packed-refs');
    try {
      this.packedWatcher = fs.watch(path.dirname(packedPath), (_ev, fn) => {
        if (fn === 'packed-refs') void this.emit();
      });
    } catch (e) {
      this.opts.onError?.(String(e));
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.watcher?.close(); this.watcher = null;
    this.packedWatcher?.close(); this.packedWatcher = null;
  }

  private async emit(): Promise<void> {
    const head = this.repo.head(this.opts.branch);
    const sha = head?.sha ?? null;
    if (sha === this.lastSha) return;
    this.lastSha = sha;
    const headFiles = this.repo.headFiles(this.opts.branch);
    const payload: FilesPayload = {
      dirty: [],
      head,
      headFiles,
      branchBase: null,
      live: false,
      dirty_submodules: [],
    };
    this.opts.onSnapshot(payload);
  }
}
