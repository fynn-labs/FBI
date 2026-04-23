import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GhClient } from './gh.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const cp = await import('node:child_process');
const execFile = cp.execFile as unknown as ReturnType<typeof vi.fn>;

function mockOk(stdout: string) {
  execFile.mockImplementationOnce((_bin, _args, _opts, cb) =>
    cb(null, { stdout, stderr: '' }));
}
function mockErr(code: number, stderr: string) {
  execFile.mockImplementationOnce((_bin, _args, _opts, cb) => {
    const err: Error & { code?: number } = new Error(stderr);
    err.code = code;
    cb(err, { stdout: '', stderr });
  });
}

describe('GhClient', () => {
  beforeEach(() => execFile.mockReset());

  it('available returns true when gh --version succeeds', async () => {
    mockOk('gh version 2.40.0');
    const gh = new GhClient();
    expect(await gh.available()).toBe(true);
  });

  it('available returns false when gh not on PATH', async () => {
    mockErr(127, 'gh: command not found');
    const gh = new GhClient();
    expect(await gh.available()).toBe(false);
  });

  it('prForBranch returns null when no PR', async () => {
    mockOk('[]');
    const gh = new GhClient();
    expect(await gh.prForBranch('me/foo', 'bar')).toBeNull();
  });

  it('prForBranch parses PR metadata', async () => {
    mockOk(JSON.stringify([{ number: 7, url: 'https://x', state: 'OPEN', title: 'T' }]));
    const gh = new GhClient();
    const pr = await gh.prForBranch('me/foo', 'bar');
    expect(pr).toEqual({ number: 7, url: 'https://x', state: 'OPEN', title: 'T' });
  });

  it('createPr posts gh pr create and parses url', async () => {
    mockOk('https://github.com/me/foo/pull/9\n');
    mockOk(JSON.stringify([{ number: 9, url: 'https://github.com/me/foo/pull/9', state: 'OPEN', title: 'T' }]));
    const gh = new GhClient();
    const pr = await gh.createPr('me/foo', { head: 'bar', base: 'main', title: 'T', body: 'B' });
    expect(pr.number).toBe(9);
  });

  it('commitsOnBranch parses commit list', async () => {
    mockOk(JSON.stringify([
      { sha: 'aaa', commit: { message: 'feat: x\n\nbody', committer: { date: '2026-04-23T10:00:00Z' } } },
      { sha: 'bbb', commit: { message: 'test: y', committer: { date: '2026-04-23T10:05:00Z' } } },
    ]));
    const gh = new GhClient();
    const commits = await gh.commitsOnBranch('me/foo', 'feat/x');
    expect(commits).toEqual([
      { sha: 'aaa', subject: 'feat: x', committed_at: Date.parse('2026-04-23T10:00:00Z') / 1000, pushed: true },
      { sha: 'bbb', subject: 'test: y', committed_at: Date.parse('2026-04-23T10:05:00Z') / 1000, pushed: true },
    ]);
  });

  it('commitsOnBranch returns [] on error', async () => {
    mockErr(1, 'nope');
    const gh = new GhClient();
    expect(await gh.commitsOnBranch('me/foo', 'feat/x')).toEqual([]);
  });

});
