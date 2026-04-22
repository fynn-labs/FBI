import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { SecretsRepo } from '../db/secrets.js';
import { RunsRepo } from '../db/runs.js';
import { registerProjectRoutes } from './projects.js';

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const secrets = new SecretsRepo(db, crypto.randomBytes(32));
  const runs = new RunsRepo(db);
  const app = Fastify();
  registerProjectRoutes(app, { projects, secrets, runs });
  return { app, projects, runs };
}

describe('projects routes', () => {
  it('POST /api/projects creates + GET /api/projects lists', async () => {
    const { app } = makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'foo',
        repo_url: 'git@github.com:x/y.git',
        default_branch: 'main',
      },
    });
    expect(create.statusCode).toBe(201);
    const listed = await app.inject({ method: 'GET', url: '/api/projects' });
    const body = listed.json() as Array<{ name: string }>;
    expect(body.map((p) => p.name)).toEqual(['foo']);
  });

  it('PATCH updates, DELETE removes', async () => {
    const { app } = makeApp();
    const { json: id } = (await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'a', repo_url: 'r', default_branch: 'main' },
    })).json() as { json: number; id: number };
    const created = (await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'b', repo_url: 'r', default_branch: 'main' },
    })).json() as { id: number };
    await app.inject({
      method: 'PATCH', url: `/api/projects/${created.id}`,
      payload: { instructions: 'be careful' },
    });
    const got = (await app.inject({
      method: 'GET', url: `/api/projects/${created.id}`,
    })).json() as { instructions: string };
    expect(got.instructions).toBe('be careful');
    const del = await app.inject({
      method: 'DELETE', url: `/api/projects/${created.id}`,
    });
    expect(del.statusCode).toBe(204);
  });

  it('GET /api/projects/:id/prompts/recent returns distinct prompts newest-first', async () => {
    const { app, projects, runs } = makeApp();
    const p = projects.create({
      name: 'x', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    runs.create({
      project_id: p.id,
      prompt: 'alpha',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.create({
      project_id: p.id,
      prompt: 'beta',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/prompts/recent?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { prompt: string }[];
    expect(body.map((x) => x.prompt)).toEqual(['beta', 'alpha']);
  });
});
