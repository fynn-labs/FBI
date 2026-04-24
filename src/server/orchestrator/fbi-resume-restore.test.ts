import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'fbi-resume-restore.sh');

function g(cwd: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
}

interface Fx { root: string; work: string; bare: string; wipRepo: string; resultPath: string; }

function setup(): Fx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const wipRepo = path.join(root, 'wip.git');
  const resultPath = path.join(root, 'result.json');
  execFileSync('git', ['init', '--bare', '--initial-branch', 'main', bare]);
  execFileSync('git', ['init', '--initial-branch', 'main', work]);
  g(work, 'config', 'user.name', 'T'); g(work, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  g(work, 'add', '.'); g(work, 'commit', '-m', 'base');
  g(work, 'remote', 'add', 'origin', bare);
  g(work, 'checkout', '-b', 'claude/run-1');
  g(work, 'push', '-u', 'origin', 'claude/run-1');
  execFileSync('git', ['init', '--bare', '--initial-branch', 'wip', wipRepo]);
  g(work, 'remote', 'add', 'fbi-wip', wipRepo);
  return { root, work, bare, wipRepo, resultPath };
}

function run(fx: Fx): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(SCRIPT, [], {
    cwd: fx.work,
    env: { ...process.env, FBI_WORKSPACE: fx.work, FBI_RUN_ID: '1', FBI_AGENT_BRANCH: 'claude/run-1', FBI_RESULT_PATH: fx.resultPath },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

describe('fbi-resume-restore.sh', () => {
  let fx: Fx;
  beforeEach(() => { fx = setup(); });
  afterEach(() => { fs.rmSync(fx.root, { recursive: true, force: true }); });

  it('no-op when wip ref does not exist', () => {
    const r = run(fx);
    expect(r.code).toBe(0);
    // working tree unchanged
    expect(fs.readFileSync(path.join(fx.work, 'a.txt'), 'utf8')).toBe('base\n');
  });

  it('restores snapshot tree on top of claude/run-N', () => {
    // Seed a snapshot in wip.git: tree has a.txt=modified, new.txt added.
    const seed = fs.mkdtempSync(path.join(fx.root, 'seed-'));
    execFileSync('git', ['clone', fx.bare, seed]);
    g(seed, 'config', 'user.name', 'T'); g(seed, 'config', 'user.email', 't@t');
    g(seed, 'checkout', 'claude/run-1');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(seed, 'new.txt'), 'hi\n');
    g(seed, 'add', '.'); g(seed, 'commit', '-m', 'snap');
    g(seed, 'push', fx.wipRepo, '+HEAD:refs/heads/wip');

    const r = run(fx);
    expect(r.code).toBe(0);
    // a.txt overwritten, new.txt present
    expect(fs.readFileSync(path.join(fx.work, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(fs.readFileSync(path.join(fx.work, 'new.txt'), 'utf8')).toBe('hi\n');
    // HEAD is still claude/run-1 (the snapshot's parent)
    const head = g(fx.work, 'rev-parse', 'HEAD');
    expect(head).toBe(g(fx.bare, 'rev-parse', 'claude/run-1'));
  });

  it('writes resume_failed result.json when origin diverged', () => {
    // Seed an unrelated commit onto origin/claude/run-1.
    const alt = fs.mkdtempSync(path.join(fx.root, 'alt-'));
    execFileSync('git', ['clone', fx.bare, alt]);
    g(alt, 'config', 'user.name', 'T'); g(alt, 'config', 'user.email', 't@t');
    g(alt, 'checkout', 'claude/run-1');
    fs.writeFileSync(path.join(alt, 'orphan'), 'x');
    g(alt, 'add', '.'); g(alt, 'commit', '-m', 'orphan');
    g(alt, 'push', '--force', 'origin', 'claude/run-1');
    g(fx.work, 'fetch', 'origin'); // refresh local view

    // Seed a snapshot whose parent is the *old* claude/run-1 tip.
    const seed = fs.mkdtempSync(path.join(fx.root, 'seed-'));
    execFileSync('git', ['init', '--initial-branch', 'main', seed]);
    g(seed, 'config', 'user.name', 'T'); g(seed, 'config', 'user.email', 't@t');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'base\n');
    g(seed, 'add', '.'); g(seed, 'commit', '-m', 'fake-base');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'changed\n');
    g(seed, 'add', '.'); g(seed, 'commit', '-m', 'snap');
    g(seed, 'push', fx.wipRepo, '+HEAD:refs/heads/wip');

    const r = run(fx);
    expect(r.code).not.toBe(0);
    const result = JSON.parse(fs.readFileSync(fx.resultPath, 'utf8'));
    expect(result.stage).toBe('restore');
    expect(result.error).toBe('diverged');
  });
});
