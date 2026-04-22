import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { registerRunsRoutes } from './runs.js';

const stubGh = {
  available: async () => true,
  prForBranch: async () => null,
  prChecks: async () => [],
  createPr: async () => ({ number: 1, url: 'u', state: 'OPEN' as const, title: 't' }),
  compareFiles: async () => [],
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const launched: number[] = [];
  const cancelled: number[] = [];
  const app = Fastify();
  registerRunsRoutes(app, {
    runs, projects, gh: stubGh,
    runsDir: dir,
    launch: async (id: number) => {
      launched.push(id);
    },
    cancel: async (id: number) => {
      cancelled.push(id);
    },
  });
  return { app, projectId: p.id, launched, cancelled };
}

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const app = Fastify();
  registerRunsRoutes(app, {
    runs, projects, gh: stubGh,
    runsDir: dir,
    launch: async (_id: number) => {},
    cancel: async (_id: number) => {},
  });
  return { app, projects, runs };
}

describe('runs routes', () => {
  it('POST /api/projects/:id/runs creates + invokes launch', async () => {
    const { app, projectId, launched } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runs`,
      payload: { prompt: 'fix the bug' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: number };
    expect(launched).toEqual([body.id]);
  });

  it('GET /api/runs lists all', async () => {
    const { app, projectId } = setup();
    await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/runs`, payload: { prompt: 'x' },
    });
    const list = (await app.inject({ method: 'GET', url: '/api/runs' })).json();
    expect((list as unknown[]).length).toBe(1);
  });

  it('DELETE /api/runs/:id on queued run deletes without cancelling', async () => {
    const { app, projectId, cancelled } = setup();
    const r = (await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/runs`, payload: { prompt: 'x' },
    })).json() as { id: number };
    await app.inject({ method: 'DELETE', url: `/api/runs/${r.id}` });
    expect(cancelled).toEqual([]);
  });

  it('GET /api/runs?limit=2&offset=0 returns paged shape', async () => {
    const { app, projects, runs } = makeApp();
    const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
    for (let i = 0; i < 3; i++) {
      runs.create({ project_id: p.id, prompt: `p${i}`,
        log_path_tmpl: (id) => `/tmp/${id}.log` });
    }
    const res = await app.inject({ method: 'GET', url: '/api/runs?limit=2&offset=0' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.total).toBe(3);
    expect(body.items.length).toBe(2);
  });

  it('GET /api/runs?state=succeeded&q=login filters', async () => {
    const { app, projects, runs } = makeApp();
    const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
    const r1 = runs.create({ project_id: p.id, prompt: 'fix login',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.create({ project_id: p.id, prompt: 'other',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.markStarted(r1.id, 'c');
    runs.markFinished(r1.id, { state: 'succeeded' });

    const res = await app.inject({ method: 'GET', url: '/api/runs?state=succeeded&q=login&limit=50&offset=0' });
    const body = res.json() as { items: Array<{ prompt: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].prompt).toBe('fix login');
  });
});
