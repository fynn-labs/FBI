import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { SecretsRepo } from '../db/secrets.js';
import { registerProjectRoutes } from './projects.js';

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const secrets = new SecretsRepo(db, crypto.randomBytes(32));
  const app = Fastify();
  registerProjectRoutes(app, { projects, secrets });
  return app;
}

describe('projects routes', () => {
  it('POST /api/projects creates + GET /api/projects lists', async () => {
    const app = makeApp();
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
    const app = makeApp();
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
});
