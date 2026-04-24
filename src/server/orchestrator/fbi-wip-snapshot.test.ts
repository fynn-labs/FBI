import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'fbi-wip-snapshot.sh');

interface Fixture {
  root: string;
  work: string;
  bare: string;
}

function g(cwd: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
}

function setup(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'wip.git');
  fs.mkdirSync(work);
  execFileSync('git', ['init', '--initial-branch', 'main', work]);
  execFileSync('git', ['init', '--bare', '--initial-branch', 'wip', bare]);
  g(work, 'config', 'user.name', 'T');
  g(work, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'base');
  g(work, 'remote', 'add', 'fbi-wip', bare);
  return { root, work, bare };
}

function run(work: string): { code: number; stdout: string } {
  const r = spawnSync(SCRIPT, [], {
    cwd: work, env: { ...process.env, FBI_WORKSPACE: work, FBI_RUN_ID: '7' }, encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout.trim() };
}

describe('fbi-wip-snapshot.sh', () => {
  let fx: Fixture;
  beforeEach(() => { fx = setup(); });
  afterEach(() => { fs.rmSync(fx.root, { recursive: true, force: true }); });

  it('no-op when tree is clean', () => {
    const r = run(fx.work);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.noop).toBe(true);
  });

  it('snapshots staged, unstaged, and untracked into fbi-wip/wip', () => {
    fs.writeFileSync(path.join(fx.work, 'a.txt'), 'dirty\n');
    fs.writeFileSync(path.join(fx.work, 'new.txt'), 'n\n');
    const r = run(fx.work);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.sha).toMatch(/^[0-9a-f]{40}$/);

    // wip ref exists on the bare repo
    const wipSha = g(fx.bare, 'rev-parse', 'refs/heads/wip');
    expect(wipSha).toBe(j.sha);

    // Working tree, HEAD, and index are unchanged
    const head = g(fx.work, 'rev-parse', 'HEAD');
    expect(head).not.toBe(wipSha);
    expect(fs.readFileSync(path.join(fx.work, 'a.txt'), 'utf8')).toBe('dirty\n');
    expect(fs.readFileSync(path.join(fx.work, 'new.txt'), 'utf8')).toBe('n\n');
    // Use execFileSync directly (without .trim()) so leading whitespace in
    // porcelain columns is preserved on the first line.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: fx.work, encoding: 'utf8' });
    expect(status).toContain(' M a.txt');
    expect(status).toContain('?? new.txt');
  });

  it('returns structured failure and exit 0 when push fails', () => {
    fs.writeFileSync(path.join(fx.work, 'a.txt'), 'dirty\n');
    // Point fbi-wip at a non-existent path
    g(fx.work, 'remote', 'set-url', 'fbi-wip', path.join(fx.root, 'missing'));
    const r = run(fx.work);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(false);
    expect(j.reason).toBe('push');
  });
});
