import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeguardRepo } from './safeguardRepo.js';

function makeBareWithCommit(root: string): { bare: string; sha: string } {
  const bare = path.join(root, 'wip.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch', 'feat/x', bare]);
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--initial-branch', 'feat/x', work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'hi\n');
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'first']);
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', work, 'push', 'origin', 'feat/x']);
  const sha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { bare, sha };
}

describe('SafeguardRepo', () => {
  it('head() returns sha+subject for a branch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-'));
    const { bare, sha } = makeBareWithCommit(root);
    const r = new SafeguardRepo(bare);
    expect(r.head('feat/x')).toEqual({ sha, subject: 'first' });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('listCommits() returns the commits from base to head', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-'));
    const { bare } = makeBareWithCommit(root);
    const r = new SafeguardRepo(bare);
    const commits = r.listCommits('feat/x', '0000000000000000000000000000000000000000');
    expect(commits.length).toBe(1);
    expect(commits[0].subject).toBe('first');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refExists() is false for an unknown branch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-'));
    const { bare } = makeBareWithCommit(root);
    const r = new SafeguardRepo(bare);
    expect(r.refExists('nope/x')).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
