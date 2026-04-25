import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { Run, ChangesPayload } from '@shared/types.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('/api/runs/:id/changes', () => {
  it('returns commits from the safeguard bare repo when the live container is gone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chg-'));
    const bare = path.join(root, '1', 'wip.git');
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '--bare', '--initial-branch', 'feat/x', bare]);
    const work = path.join(root, 'w');
    execFileSync('git', ['clone', bare, work]);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a'), 'x');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'feat: hello']);
    execFileSync('git', ['-C', work, 'push', 'origin', 'feat/x']);

    const app = Fastify();
    const runs = {
      get: (id: number) => id === 1
        ? { id: 1, project_id: 1, state: 'succeeded', branch_name: 'feat/x',
            mirror_status: null, base_branch: null } as unknown as Run
        : undefined,
      listByParent: () => [],
      setBranchName: () => {},
    };
    const projects = { get: () => ({ id: 1, default_branch: 'main', repo_url: 'git@example:x/y.git' }) };
    const gh = { available: async () => false, prForBranch: async () => null, prChecks: async () => [], compareBranch: async () => ({ commits: [], aheadBy: 0, behindBy: 0, mergeBaseSha: '' }), compareFiles: async () => [] };
    const mod = await import('./runs.js');
    mod.registerRunsRoutes(app as never, {
      runs: runs as never, projects: projects as never, gh: gh as never,
      streams: { getOrCreateEvents: () => ({ publish: () => {} }) } as never,
      runsDir: root, draftUploadsDir: root,
      launch: async () => {}, cancel: async () => {}, fireResumeNow: () => {},
      continueRun: async () => {}, markStartingForContinueRequest: () => {},
      orchestrator: {
        writeStdin: () => {},
        execInContainer: async () => ({ stdout: '', stderr: '', exitCode: 127 }),
        execHistoryOp: async () => ({ kind: 'gh-error', message: '' }),
        spawnSubRun: async () => 0, deleteRun: () => {}, initSafeguard: () => {},
      } as never,
      wipRepo: { exists: () => true, snapshotSha: () => null, parentSha: () => null,
        readSnapshotFiles: () => [], readSnapshotDiff: () => ({ path: '', ref: 'wip', hunks: [], truncated: false }),
        readSnapshotPatch: () => '', deleteWipRef: () => {},
      } as never,
    });

    const res = await app.inject({ method: 'GET', url: '/api/runs/1/changes' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChangesPayload;
    expect(body.commits.length).toBe(1);
    expect(body.commits[0].subject).toBe('feat: hello');
    expect(body.commits[0].pushed).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
