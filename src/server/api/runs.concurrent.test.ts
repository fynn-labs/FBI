import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

describe('POST /api/projects/:id/runs — concurrent-branch guard', () => {
  it('returns 409 when a non-terminal run already holds the branch; 201 with { force: true }', async () => {
    const app = Fastify();
    const active = [{ id: 5, state: 'running', branch_name: 'feat/x' } as any];
    const runs = {
      create: () => ({ id: 99, project_id: 1, state: 'queued', branch_name: '' }),
      listActiveByBranch: (_p: number, b: string) => (b === 'feat/x' ? active : []),
      setBranchName: () => {},
      setBaseBranch: () => {},
      delete: () => {},
      get: () => ({ id: 99, project_id: 1, state: 'queued', branch_name: 'feat/x' } as any),
    };
    const projects = { get: () => ({ id: 1, default_branch: 'main' }) };
    const mod = await import('./runs.js');
    mod.registerRunsRoutes(app as any, {
      runs: runs as any, projects: projects as any,
      gh: { available: async () => false } as any,
      streams: { getOrCreateEvents: () => ({ publish: () => {} }) } as any,
      runsDir: '/tmp/x', draftUploadsDir: '/tmp/x',
      launch: async () => {}, cancel: async () => {}, fireResumeNow: () => {},
      continueRun: async () => {}, markStartingForContinueRequest: () => {},
      orchestrator: {
        writeStdin: () => {},
        execInContainer: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        execHistoryOp: async () => ({ kind: 'complete', sha: '' }),
        spawnSubRun: async () => 0, deleteRun: () => {}, initSafeguard: () => {},
      } as any,
      wipRepo: {} as any,
    });
    const r1 = await app.inject({ method: 'POST', url: '/api/projects/1/runs',
      payload: { prompt: 'p', branch: 'feat/x' } });
    expect(r1.statusCode).toBe(409);
    expect(r1.json()).toMatchObject({ error: 'branch_in_use' });
    const r2 = await app.inject({ method: 'POST', url: '/api/projects/1/runs',
      payload: { prompt: 'p', branch: 'feat/x', force: true } });
    expect(r2.statusCode).toBe(201);
  });
});
