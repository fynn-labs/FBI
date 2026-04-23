import { describe, it, expect } from 'vitest';
import { parseGitState, parseSubmoduleStatus } from './gitStateWatcher.js';

describe('parseGitState', () => {
  it('parses porcelain v1 -z with staged, unstaged, and untracked', () => {
    // NUL-separated records.
    const zlist = 'M  src/a.ts\0?? src/b.ts\0';
    const numstat = '5\t2\tsrc/a.ts\n';  // b.ts is untracked → numstat doesn't list it
    const r = parseGitState({ zlist, numstat, show: '', log: '', aheadBehind: '', base: 'main' });
    expect(r.dirty).toEqual([
      { path: 'src/a.ts', status: 'M', additions: 5, deletions: 2 },
      { path: 'src/b.ts', status: 'U', additions: 0, deletions: 0 },
    ]);
    expect(r.head).toBeNull();
    expect(r.headFiles).toEqual([]);
    expect(r.branchBase).toBeNull();
  });

  it('parses rename records (skips the from-path)', () => {
    const zlist = 'R  src/new.ts\0src/old.ts\0';
    const r = parseGitState({ zlist, numstat: '', show: '', log: '', aheadBehind: '' });
    expect(r.dirty).toEqual([
      { path: 'src/new.ts', status: 'R', additions: 0, deletions: 0 },
    ]);
  });

  it('parses head commit and headFiles from git show --numstat', () => {
    const log = 'a3f2b19abc\0feat: extract parseBearer';
    const show = '8\t3\tsrc/x.ts\n22\t0\tsrc/y.ts\n';
    const r = parseGitState({ zlist: '', numstat: '', show, log, aheadBehind: '0\t3', base: 'main' });
    expect(r.head).toEqual({ sha: 'a3f2b19abc', subject: 'feat: extract parseBearer' });
    expect(r.headFiles).toEqual([
      { path: 'src/x.ts', status: 'M', additions: 8, deletions: 3 },
      { path: 'src/y.ts', status: 'A', additions: 22, deletions: 0 },
    ]);
    expect(r.branchBase).toEqual({ base: 'main', ahead: 3, behind: 0 });
  });

  it('handles binary numstat (- -) as zero additions/deletions', () => {
    const zlist = 'M  img.png\0';
    const numstat = '-\t-\timg.png\n';
    const r = parseGitState({ zlist, numstat, show: '', log: '', aheadBehind: '' });
    expect(r.dirty).toEqual([
      { path: 'img.png', status: 'M', additions: 0, deletions: 0 },
    ]);
  });

  it('maps ahead/behind with LEFT=behind RIGHT=ahead', () => {
    const r = parseGitState({ zlist: '', numstat: '', show: '', log: '', aheadBehind: '2\t5', base: 'main' });
    expect(r.branchBase).toEqual({ base: 'main', ahead: 5, behind: 2 });
  });
});

describe('parseSubmoduleStatus', () => {
  it('detects dirty submodules via + marker', () => {
    const status = ' a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9 docs (docs-a1)\n+abcdef0123456789abcdef0123456789abcdef01 cli/fbi-tunnel (fbi-tunnel-v1)\n';
    const info = 'submodule.cli-tunnel.path cli/fbi-tunnel\nsubmodule.cli-tunnel.url https://github.com/x/y\nsubmodule.docs.path docs\nsubmodule.docs.url https://github.com/x/z\n';
    const r = parseSubmoduleStatus(status, info);
    expect(r).toEqual([
      { path: 'cli/fbi-tunnel', url: 'https://github.com/x/y', dirty_paths: [] },
    ]);
  });
  it('returns [] on empty input', () => {
    expect(parseSubmoduleStatus('', '')).toEqual([]);
  });
});
