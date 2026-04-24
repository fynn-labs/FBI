import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeCommit, FilesHeadEntry } from '../../shared/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function gitOpt(cwd: string, ...args: string[]): string | null {
  try { return git(cwd, ...args); } catch { return null; }
}

export class SafeguardRepo {
  constructor(private readonly bareDir: string) {}

  exists(): boolean {
    return fs.existsSync(path.join(this.bareDir, 'HEAD'));
  }

  refPath(branch: string): string {
    return path.join(this.bareDir, 'refs', 'heads', branch);
  }

  refExists(branch: string): boolean {
    if (!this.exists()) return false;
    const out = gitOpt(this.bareDir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
    return !!(out && out.trim().length > 0);
  }

  head(branch: string): { sha: string; subject: string } | null {
    if (!this.refExists(branch)) return null;
    const raw = gitOpt(this.bareDir, 'log', '-1', '--format=%H%x00%s', `refs/heads/${branch}`);
    if (!raw) return null;
    const nul = raw.indexOf('\0');
    if (nul < 0) return null;
    return { sha: raw.slice(0, nul), subject: raw.slice(nul + 1).replace(/\n+$/, '') };
  }

  /** Commits reachable from `branch` but not from `baseSha`, newest-first. */
  listCommits(branch: string, baseSha: string): ChangeCommit[] {
    if (!this.refExists(branch)) return [];
    const isRealSha = /^[0-9a-f]{40}$/.test(baseSha) && baseSha !== '0'.repeat(40);
    const spec = isRealSha
      ? `${baseSha}..refs/heads/${branch}`
      : `refs/heads/${branch}`;
    const raw = gitOpt(this.bareDir, 'log', '--format=%H%x00%s%x00%ct', spec);
    if (!raw) return [];
    const commits: ChangeCommit[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [sha, subject, tsStr] = line.split('\0');
      if (!sha) continue;
      const committed_at = Number.parseInt(tsStr ?? '0', 10) || 0;
      commits.push({
        sha, subject: subject ?? '', committed_at, pushed: false,
        files: [], files_loaded: false, submodule_bumps: [],
      });
    }
    return commits;
  }

  headFiles(branch: string): FilesHeadEntry[] {
    if (!this.refExists(branch)) return [];
    const raw = gitOpt(this.bareDir, 'show', '--numstat', '--format=', `refs/heads/${branch}`);
    if (!raw) return [];
    const out: FilesHeadEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [a, d, p] = line.split('\t');
      if (!p) continue;
      const adds = a === '-' ? 0 : Number.parseInt(a, 10) || 0;
      const dels = d === '-' ? 0 : Number.parseInt(d, 10) || 0;
      const status: 'A' | 'M' | 'D' =
        adds === 0 && dels > 0 ? 'D' :
        dels === 0 && adds > 0 ? 'A' : 'M';
      out.push({ path: p, status, additions: adds, deletions: dels });
    }
    return out;
  }
}
