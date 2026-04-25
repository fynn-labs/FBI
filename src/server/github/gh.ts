import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Wrap with options so the mock sees the 4-arg form (_bin, _args, _opts, cb)
// and resolves with { stdout, stderr }.
const _execFile = promisify(execFile);
function ex(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return _execFile(bin, args, {}) as Promise<{ stdout: string; stderr: string }>;
}

export interface Pr {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
}

export interface Check {
  name: string;
  status: 'pending' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled' | null;
}

export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'removed' | 'renamed';
}

export class GhClient {
  constructor(private bin: string = 'gh') {}

  async available(): Promise<boolean> {
    try {
      await ex(this.bin, ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async prForBranch(repo: string, branch: string): Promise<Pr | null> {
    const { stdout } = await ex(this.bin, [
      'pr', 'list', '--repo', repo, '--head', branch, '--state', 'all',
      '--json', 'number,url,state,title', '--limit', '1',
    ]);
    const arr = JSON.parse(stdout || '[]') as Pr[];
    return arr[0] ?? null;
  }

  async prChecks(repo: string, branch: string): Promise<Check[]> {
    try {
      const { stdout } = await ex(this.bin, [
        'pr', 'checks', branch, '--repo', repo, '--json', 'name,status,conclusion',
      ]);
      return JSON.parse(stdout || '[]') as Check[];
    } catch {
      return [];
    }
  }

  async createPr(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<Pr> {
    await ex(this.bin, [
      'pr', 'create', '--repo', repo,
      '--head', p.head, '--base', p.base,
      '--title', p.title, '--body', p.body,
    ]);
    const pr = await this.prForBranch(repo, p.head);
    if (!pr) throw new Error('created PR but could not re-fetch it');
    return pr;
  }

  async compareFiles(repo: string, base: string, head: string): Promise<FileChange[]> {
    const { stdout } = await ex(this.bin, [
      'api', `repos/${repo}/compare/${base}...${head}`,
      '--jq', '.files | map({filename, additions, deletions, status})',
    ]);
    return JSON.parse(stdout || '[]') as FileChange[];
  }

  async compareBranch(
    repo: string, baseBranch: string, branch: string,
  ): Promise<{
    commits: Array<{ sha: string; subject: string; committed_at: number; pushed: boolean }>;
    aheadBy: number;
    behindBy: number;
    mergeBaseSha: string;
  }> {
    const url = `repos/${repo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}`;
    try {
      const { stdout } = await ex(this.bin, ['api', url]);
      const data = JSON.parse(stdout || '{}') as {
        ahead_by?: number;
        behind_by?: number;
        merge_base_commit?: { sha: string };
        commits?: Array<{
          sha: string;
          commit: { message: string; committer: { date: string } };
        }>;
      };
      return {
        commits: (data.commits ?? []).map((c) => ({
          sha: c.sha,
          subject: (c.commit?.message ?? '').split('\n', 1)[0] ?? '',
          committed_at: Math.floor(Date.parse(c.commit?.committer?.date ?? '') / 1000) || 0,
          pushed: true,
        })),
        aheadBy: data.ahead_by ?? 0,
        behindBy: data.behind_by ?? 0,
        mergeBaseSha: data.merge_base_commit?.sha ?? '',
      };
    } catch {
      return { commits: [], aheadBy: 0, behindBy: 0, mergeBaseSha: '' };
    }
  }

}

export class GhError extends Error {}
