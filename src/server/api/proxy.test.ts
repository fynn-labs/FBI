import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { registerProxyRoutes } from './proxy.js';

interface Container {
  inspect: () => Promise<{ State: { Pid: number }; NetworkSettings: { IPAddress: string; Networks?: Record<string, { IPAddress: string }> } }>;
}

function makeApp(opts: {
  runsRepo: RunsRepo;
  streams?: RunStreamRegistry;
  getLiveContainer: (runId: number) => Container | null;
  procReader?: (pid: number) => string;
}): Promise<FastifyInstance> {
  const app = Fastify();
  registerProxyRoutes(app, {
    runs: opts.runsRepo,
    streams: opts.streams ?? new RunStreamRegistry(),
    orchestrator: { getLiveContainer: opts.getLiveContainer as never },
    procReader: opts.procReader,
  });
  return Promise.resolve(app.ready()).then(() => app);
}

function setupRunsRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-proxy-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const make = () => runs.create({
    project_id: p.id, prompt: 'hi',
    log_path_tmpl: (id) => path.join(dir, `${id}.log`),
  });
  return { runs, make };
}

describe('GET /api/runs/:id/listening-ports', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it('returns 404 when run does not exist', async () => {
    const { runs } = setupRunsRepo();
    app = await makeApp({ runsRepo: runs, getLiveContainer: () => null });
    const res = await app.inject({ method: 'GET', url: '/api/runs/999/listening-ports' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when run exists but has no live container', async () => {
    const { runs, make } = setupRunsRepo();
    const run = make(); // queued, no container
    app = await makeApp({ runsRepo: runs, getLiveContainer: () => null });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/listening-ports` });
    expect(res.statusCode).toBe(409);
  });

  it('returns the parsed LISTEN ports for a running container', async () => {
    const { runs, make } = setupRunsRepo();
    const run = make();
    runs.markStarted(run.id, 'cid');
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 12345 },
        NetworkSettings: { IPAddress: '172.17.0.5' },
      }),
    };
    const procReader = vi.fn().mockReturnValue(
      `  sl  local_address rem_address   st ...
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 a 100 0 0 10 0
`,
    );
    app = await makeApp({
      runsRepo: runs,
      getLiveContainer: () => container,
      procReader,
    });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/listening-ports` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ports: [{ port: 5173, proto: 'tcp' }] });
    expect(procReader).toHaveBeenCalledWith(12345);
  });
});
