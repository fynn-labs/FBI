import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = path.join(HERE, 'fbi-history-op.sh');

describe('fbi-history-op.sh safeguard preference', () => {
  it('fetches the run branch from /safeguard before origin for FBI_OP=sync', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-'));
    const ws = path.join(root, 'ws');
    const safe = path.join(root, 'wip.git');
    const originBare = path.join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch', 'main', originBare]);
    execFileSync('git', ['init', '--bare', '--initial-branch', 'feat/x', safe]);
    execFileSync('git', ['clone', originBare, ws]);
    execFileSync('git', ['-C', ws, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', ws, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(ws, 'a'), '1');
    execFileSync('git', ['-C', ws, 'add', '.']);
    execFileSync('git', ['-C', ws, 'commit', '-m', 'init']);
    execFileSync('git', ['-C', ws, 'push', 'origin', 'HEAD:refs/heads/main']);
    const seed = path.join(root, 'seed');
    execFileSync('git', ['clone', safe, seed]);
    execFileSync('git', ['-C', seed, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', seed, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(seed, 'b'), '2');
    execFileSync('git', ['-C', seed, 'add', '.']);
    execFileSync('git', ['-C', seed, 'commit', '-m', 'feat: from claude']);
    execFileSync('git', ['-C', seed, 'push', 'origin', 'HEAD:refs/heads/feat/x']);
    const src = fs.readFileSync(SCRIPT_SRC, 'utf8')
      .replace(/\/workspace\b/g, ws)
      .replace(/\/safeguard\b/g, safe);
    const script = path.join(root, 'hop.sh');
    fs.writeFileSync(script, src, { mode: 0o755 });
    const res = spawnSync('bash', [script], {
      env: { ...process.env, FBI_OP: 'sync', FBI_BRANCH: 'feat/x', FBI_DEFAULT: 'main', FBI_RUN_ID: '7',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t' },
      encoding: 'utf8',
    });
    expect(res.stdout).toContain('"ok":true');
    const origBranches = execFileSync('git', ['-C', originBare, 'branch', '--list'], { encoding: 'utf8' });
    expect(origBranches).toContain('feat/x');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
