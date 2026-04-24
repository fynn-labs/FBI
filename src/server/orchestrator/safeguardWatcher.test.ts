import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeguardWatcher } from './safeguardWatcher.js';

function makeBare(root: string, branch: string): string {
  const bare = path.join(root, 'wip.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch', branch, bare]);
  return bare;
}

describe('SafeguardWatcher', () => {
  it('emits a snapshot on ref change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgw-'));
    const bare = makeBare(root, 'feat/x');
    const work = path.join(root, 'work');
    execFileSync('git', ['clone', bare, work]);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a'), '1');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'first']);
    const emitted: Array<{ sha: string }> = [];
    const w = new SafeguardWatcher({
      bareDir: bare, branch: 'feat/x',
      onSnapshot: (snap) => { emitted.push({ sha: snap.head?.sha ?? '' }); },
    });
    await w.start();
    execFileSync('git', ['-C', work, 'push', 'origin', 'feat/x']);
    await new Promise((r) => setTimeout(r, 250));
    await w.stop();
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[emitted.length - 1].sha).toMatch(/^[0-9a-f]{40}$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
