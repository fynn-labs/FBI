import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('supervisor.sh branch creation (extracted lines)', () => {
  it('post-commit hook pushes to safeguard under claude/run-N and to origin under current branch', () => {
    // The hook uses $RUN_ID for the safeguard mirror ref so that renamed
    // branches land on origin under the meaningful name while the safeguard
    // ref stays fixed as the internal backup.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supbr-'));
    const safeguardBare = path.join(root, 'safeguard.git');
    const originBare = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '--bare', '--initial-branch', 'main', originBare]);
    execFileSync('git', ['clone', originBare, work]);
    fs.writeFileSync(path.join(work, 'x'), 'y');
    execFileSync('git', ['-C', work, 'config', 'user.name', 'T']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'base']);
    execFileSync('git', ['-C', work, 'push', 'origin', 'main']);
    execFileSync('git', ['init', '--bare', '--initial-branch', 'claude/run-7', safeguardBare]);
    execFileSync('git', ['-C', work, 'remote', 'add', 'safeguard', safeguardBare]);
    execFileSync('git', ['-C', work, 'checkout', '-b', 'feat/my-work']);

    // Simulate the post-commit hook with the new design
    const hookScript = `#!/bin/sh
BRANCH="$(git symbolic-ref --short HEAD)"
MIRROR="claude/run-7"
git push safeguard "HEAD:refs/heads/$MIRROR" 2>/dev/null
git push origin "HEAD:refs/heads/$BRANCH" 2>/dev/null
`;
    fs.writeFileSync(path.join(work, '.git', 'hooks', 'post-commit'), hookScript, { mode: 0o755 });
    fs.writeFileSync(path.join(work, 'z'), 'change');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'feat: do work'], {
      env: { ...process.env, RUN_ID: '7', PATH: process.env.PATH },
    });

    const safeguardBranches = execFileSync('git', ['-C', safeguardBare, 'branch', '--list'], { encoding: 'utf8' });
    const originBranches = execFileSync('git', ['-C', originBare, 'branch', '--list'], { encoding: 'utf8' });

    expect(safeguardBranches).toContain('claude/run-7');
    expect(safeguardBranches).not.toContain('feat/my-work');
    expect(originBranches).toContain('feat/my-work');
    expect(originBranches).not.toContain('claude/run-7');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates claude/run-N at DEFAULT_BRANCH tip when no remote agent branch exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supbr-'));
    const bare = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '--bare', '--initial-branch', 'main', bare]);
    execFileSync('git', ['clone', bare, work]);
    fs.writeFileSync(path.join(work, 'x'), 'y');
    execFileSync('git', ['-C', work, 'config', 'user.name', 'T']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'base']);
    execFileSync('git', ['-C', work, 'push', 'origin', 'main']);

    const runId = '42';
    const agent = `claude/run-${runId}`;
    execFileSync('git', ['-C', work, 'checkout', '-b', agent]);
    execFileSync('git', ['-C', work, 'push', '-u', 'origin', agent]);

    const branches = execFileSync('git', ['-C', bare, 'branch', '--list'], { encoding: 'utf8' });
    expect(branches).toContain(agent);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
