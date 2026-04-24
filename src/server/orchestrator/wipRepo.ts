import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FilesDirtyEntry, FileDiffPayload } from '../../shared/types.js';
import { parseUnifiedDiff } from '../diffParse.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).toString();
}

export class WipRepo {
  constructor(private readonly baseDir: string) {}

  path(runId: number): string {
    return path.join(this.baseDir, String(runId), 'wip.git');
  }

  exists(runId: number): boolean {
    return fs.existsSync(path.join(this.path(runId), 'HEAD'));
  }

  init(runId: number): string {
    const p = this.path(runId);
    if (this.exists(runId)) return p;
    fs.mkdirSync(p, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch', 'wip', p]);
    // Make writable by group so both the FBI server user and the container's
    // agent user (with a matching GID, same mechanism as docker-socket
    // forwarding at 35edb0f) can push.
    execFileSync('git', ['-C', p, 'config', 'core.sharedRepository', 'group']);
    return p;
  }

  remove(runId: number): void {
    const p = this.path(runId);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* idempotent */ }
    // Also remove parent if empty.
    const parent = path.dirname(p);
    try { fs.rmdirSync(parent); } catch { /* non-empty or missing — both fine */ }
  }

  private snapshotSha(runId: number): string | null {
    if (!this.exists(runId)) return null;
    try {
      return git(this.path(runId), 'rev-parse', '--verify', '-q', 'refs/heads/wip').trim() || null;
    } catch {
      return null;
    }
  }

  parentSha(runId: number): string | null {
    const snap = this.snapshotSha(runId);
    if (!snap) return null;
    try { return git(this.path(runId), 'rev-parse', `${snap}^`).trim(); } catch { return null; }
  }

  readSnapshotFiles(runId: number): FilesDirtyEntry[] {
    const snap = this.snapshotSha(runId);
    if (!snap) return [];
    const out = git(this.path(runId), 'show', '--no-color', '--name-status', '--format=', snap);
    return out.split('\n').filter(Boolean).map((line) => {
      const [statusRaw, ...rest] = line.split('\t');
      const status = (statusRaw?.[0] ?? 'M') as FilesDirtyEntry['status'];
      return { path: rest.join('\t'), status, additions: 0, deletions: 0 };
    });
  }

  readSnapshotDiff(runId: number, filePath: string): FileDiffPayload {
    const snap = this.snapshotSha(runId);
    if (!snap) return { path: filePath, ref: 'wip', hunks: [], truncated: false };
    const parent = this.parentSha(runId);
    if (!parent) return { path: filePath, ref: 'wip', hunks: [], truncated: false };
    const out = git(
      this.path(runId), 'diff', '--no-color', '--no-ext-diff', '-U3',
      `${parent}..${snap}`, '--', filePath,
    );
    return parseUnifiedDiff(out, filePath, 'wip');
  }

  readSnapshotPatch(runId: number): string {
    const snap = this.snapshotSha(runId);
    if (!snap) return '';
    const parent = this.parentSha(runId);
    if (!parent) return '';
    return git(this.path(runId), 'format-patch', '--stdout', `${parent}..${snap}`);
  }
}
