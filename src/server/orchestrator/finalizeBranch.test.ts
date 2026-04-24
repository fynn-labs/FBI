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

const PUSH_LOG = '/tmp/last-origin-push.log';

describe('finalizeBranch.sh', () => {
  let fx: Fixture;
  // Track files we create so we can clean them up even on failure.
  const tmpFilesToClean: string[] = [];

  beforeEach(() => {
    fx = setupFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.root, { recursive: true, force: true });
    for (const f of tmpFilesToClean.splice(0)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    // Also clean up any push log left by tests.
    try { fs.unlinkSync(PUSH_LOG); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Basic smoke test
  // -------------------------------------------------------------------------

  it('exits 0 and writes result.json', () => {
    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).not.toBeNull();
  });

  it('propagates claude exit code into result JSON', () => {
    const r = runFinalize(fx, { claudeExit: '2' });
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ exit_code: 2 });
  });

  it('result JSON contains expected keys', () => {
    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toHaveProperty('exit_code');
    expect(r.result).toHaveProperty('push_exit');
    expect(r.result).toHaveProperty('head_sha');
    expect(r.result).toHaveProperty('branch');
  });

  // -------------------------------------------------------------------------
  // New behaviour: no wip commit, no push from finalize
  // -------------------------------------------------------------------------

  it('does not create a wip: commit', () => {
    // Leave an uncommitted dirty file on the work tree.
    git(fx.work, 'checkout', '-b', 'fix/dirty');
    fs.writeFileSync(path.join(fx.work, 'dirty.txt'), 'dirty\n');

    const r = runFinalize(fx);
    expect(r.status).toBe(0);

    // git log should contain no commit whose subject starts with "wip:".
    const log = git(fx.work, 'log', '--format=%s');
    expect(log).not.toMatch(/^wip:/m);
  });

  it('does not push to origin from finalize', () => {
    // Record origin/main tip before the run.
    const beforeSha = git(fx.work, 'rev-parse', 'origin/main');

    // Make a new local commit that is NOT yet on origin.
    fs.writeFileSync(path.join(fx.work, 'new.txt'), 'new\n');
    git(fx.work, 'add', '.');
    git(fx.work, 'commit', '-m', 'new local commit');

    runFinalize(fx);

    // origin/main should still be at the same SHA — finalize must not push.
    const afterSha = execFileSync(
      'git',
      ['--git-dir', fx.remote, 'rev-parse', 'main'],
      { encoding: 'utf8' },
    ).trim();
    expect(afterSha).toBe(beforeSha);
  });

  // -------------------------------------------------------------------------
  // push_exit sourced from /tmp/last-origin-push.log
  // -------------------------------------------------------------------------

  it('sets push_exit=0 when last-origin-push.log has no error indicators', () => {
    fs.writeFileSync(PUSH_LOG, 'Everything up-to-date\n');

    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ push_exit: 0 });
  });

  it('sets push_exit=1 when last-origin-push.log contains "rejected"', () => {
    fs.writeFileSync(PUSH_LOG, ' ! [rejected]   main -> main (non-fast-forward)\n');

    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ push_exit: 1 });
  });

  it('sets push_exit=1 when last-origin-push.log contains "error:"', () => {
    fs.writeFileSync(PUSH_LOG, 'error: failed to push some refs\n');

    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ push_exit: 1 });
  });

  it('sets push_exit=0 when last-origin-push.log does not exist', () => {
    try { fs.unlinkSync(PUSH_LOG); } catch { /* ok */ }

    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ push_exit: 0 });
  });

  // -------------------------------------------------------------------------
  // branch field reflects current HEAD branch
  // -------------------------------------------------------------------------

  it('branch field reflects current HEAD branch (default branch)', () => {
    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ branch: 'main' });
  });

  it('branch field reflects current HEAD branch (feature branch)', () => {
    git(fx.work, 'checkout', '-b', 'feat/my-thing');

    const r = runFinalize(fx);
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ branch: 'feat/my-thing' });
  });

  // -------------------------------------------------------------------------
  // No nuisance branches created
  // -------------------------------------------------------------------------

  it('does not create claude/run-N fallback branch on remote', () => {
    const r = runFinalize(fx, { runId: '7' });
    expect(r.status).toBe(0);
    expect(remoteBranches(fx)).not.toContain('claude/run-7');
  });
});
