import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('supervisor.sh branch creation (extracted lines)', () => {
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
