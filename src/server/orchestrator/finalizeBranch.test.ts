import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'finalizeBranch.sh');

interface Fixture {
  root: string;
  remote: string;
  work: string;
  resultPath: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function setupFixture(defaultBranch = 'main'): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-finalize-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const resultPath = path.join(root, 'result.json');

  execFileSync('git', ['init', '--bare', '--initial-branch', defaultBranch, remote]);
  execFileSync('git', ['init', '--initial-branch', defaultBranch, work]);
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'remote', 'add', 'origin', remote);

  // Seed one commit on main + push so origin/$default exists.
  fs.writeFileSync(path.join(work, 'README.md'), 'seed\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'seed');
  git(work, 'push', '-u', 'origin', defaultBranch);

  return { root, remote, work, resultPath };
}

function runFinalize(
  fx: Fixture,
  opts: { defaultBranch?: string; runId?: string; claudeExit?: string } = {},
): { stdout: string; stderr: string; status: number | null; result: Record<string, unknown> | null } {
  const res = spawnSync('bash', [SCRIPT], {
    cwd: fx.work,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEFAULT_BRANCH: opts.defaultBranch ?? 'main',
      RUN_ID: opts.runId ?? '42',
      CLAUDE_EXIT: opts.claudeExit ?? '0',
      RESULT_PATH: fx.resultPath,
    },
  });
  let result: Record<string, unknown> | null = null;
  if (fs.existsSync(fx.resultPath)) {
    result = JSON.parse(fs.readFileSync(fx.resultPath, 'utf8'));
  }
  return { stdout: res.stdout, stderr: res.stderr, status: res.status, result };
}

function remoteBranches(fx: Fixture): string[] {
  const out = execFileSync('git', ['--git-dir', fx.remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], {
    encoding: 'utf8',
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
}

describe('finalizeBranch.sh', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setupFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('no-op when claude made no changes on default branch', () => {
    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ exit_code: 0, push_exit: 0, branch: '' });
    // Fallback claude/run-N must NOT be created on the remote.
    expect(remoteBranches(fx)).toEqual(['main']);
  });

  it('creates fallback branch and pushes when claude committed on default branch', () => {
    fs.writeFileSync(path.join(fx.work, 'new.txt'), 'work\n');
    git(fx.work, 'add', '.');
    git(fx.work, 'commit', '-m', 'work');

    const r = runFinalize(fx, { runId: '7' });
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ exit_code: 0, push_exit: 0, branch: 'claude/run-7' });
    expect(remoteBranches(fx)).toContain('claude/run-7');
  });

  it('pushes feature branch as-is when claude branched and committed', () => {
    git(fx.work, 'checkout', '-b', 'fix/thing');
    fs.writeFileSync(path.join(fx.work, 'f.txt'), 'f\n');
    git(fx.work, 'add', '.');
    git(fx.work, 'commit', '-m', 'fix');

    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ push_exit: 0, branch: 'fix/thing' });
    expect(remoteBranches(fx)).toContain('fix/thing');
    // Still no nuisance claude/run-N.
    expect(remoteBranches(fx)).not.toContain('claude/run-42');
  });

  it('stages and commits leftover uncommitted work before pushing', () => {
    git(fx.work, 'checkout', '-b', 'fix/uncommitted');
    fs.writeFileSync(path.join(fx.work, 'dirty.txt'), 'dirty\n');
    // Intentionally leave unstaged.

    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ push_exit: 0, branch: 'fix/uncommitted' });
    expect(remoteBranches(fx)).toContain('fix/uncommitted');

    // The work commit should exist on remote.
    const log = execFileSync('git', ['--git-dir', fx.remote, 'log', '--format=%s', 'fix/uncommitted'], {
      encoding: 'utf8',
    });
    expect(log).toMatch(/wip: claude run 42/);
  });

  it('does NOT push and does NOT create claude/run-N when a feature branch is already merged into default', () => {
    // Claude branches from main, commits, pushes (simulating an earlier run).
    git(fx.work, 'checkout', '-b', 'feature/merged');
    fs.writeFileSync(path.join(fx.work, 'fm.txt'), 'fm\n');
    git(fx.work, 'add', '.');
    git(fx.work, 'commit', '-m', 'feature commit');
    git(fx.work, 'push', '-u', 'origin', 'feature/merged');

    // Outside party fast-forwards main to include feature/merged.
    execFileSync('git', ['--git-dir', fx.remote, 'update-ref', 'refs/heads/main', 'refs/heads/feature/merged']);

    // New run: fresh clone, checks out the feature branch, makes no new commits.
    const cloneDir = path.join(fx.root, 'clone');
    execFileSync('git', ['clone', fx.remote, cloneDir]);
    git(cloneDir, 'config', 'user.name', 'Test');
    git(cloneDir, 'config', 'user.email', 'test@example.com');
    git(cloneDir, 'checkout', 'feature/merged');

    const res = spawnSync('bash', [SCRIPT], {
      cwd: cloneDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFAULT_BRANCH: 'main',
        RUN_ID: '99',
        CLAUDE_EXIT: '0',
        RESULT_PATH: fx.resultPath,
      },
    });
    expect(res.status).toBe(0);
    const result = JSON.parse(fs.readFileSync(fx.resultPath, 'utf8'));
    // HEAD is already in main → no push, but keep the branch name so UI can
    // still link to the existing PR for feature/merged.
    expect(result.push_exit).toBe(0);
    expect(result.branch).toBe('feature/merged');
    // No nuisance fallback branch gets created.
    expect(remoteBranches(fx)).not.toContain('claude/run-99');
  });

  it('reports no branch when claude created a local-only feature branch but made no commits', () => {
    git(fx.work, 'checkout', '-b', 'feature/empty');
    // No commits made.

    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ push_exit: 0, branch: '' });
    // Branch was never on remote, so we don't falsely claim it.
    expect(remoteBranches(fx)).toEqual(['main']);
  });

  it('propagates claude exit code into the result JSON', () => {
    const r = runFinalize(fx, { claudeExit: '2' });
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ exit_code: 2, push_exit: 0, branch: '' });
  });
});
