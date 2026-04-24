import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WipRepo } from './wipRepo.js';

let root: string;
let repo: WipRepo;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wipRepo-'));
  repo = new WipRepo(root);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('WipRepo', () => {
  it('init creates a bare repo with a writable refs dir', () => {
    const p = repo.init(42);
    expect(fs.existsSync(path.join(p, 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(p, 'refs', 'heads'))).toBe(true);
    expect(repo.exists(42)).toBe(true);
  });

  it('init is idempotent', () => {
    const a = repo.init(42);
    const b = repo.init(42);
    expect(a).toBe(b);
  });

  it('remove is idempotent and deletes the repo', () => {
    repo.init(42);
    repo.remove(42);
    expect(repo.exists(42)).toBe(false);
    repo.remove(42); // no throw
  });

  it('readSnapshotFiles returns empty when no wip ref', () => {
    repo.init(42);
    expect(repo.readSnapshotFiles(42)).toEqual([]);
  });

  it('readSnapshotFiles returns dirty entries when a snapshot exists', () => {
    const bare = repo.init(42);
    // Seed a commit manually via git plumbing.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wip-seed-'));
    execFileSync('git', ['init', '--initial-branch', 'main', work]);
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'base']);
    fs.writeFileSync(path.join(work, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'snapshot']);
    execFileSync('git', ['-C', work, 'push', bare, '+HEAD:refs/heads/wip']);

    const files = repo.readSnapshotFiles(42);
    expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    const aEntry = files.find((f) => f.path === 'a.txt')!;
    expect(aEntry.status).toBe('M');
    const bEntry = files.find((f) => f.path === 'b.txt')!;
    expect(bEntry.status).toBe('A');
    fs.rmSync(work, { recursive: true, force: true });
  });
});
