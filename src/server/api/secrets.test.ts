import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { SecretsRepo } from '../db/secrets.js';
import { registerSecretsRoutes } from './secrets.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const secrets = new SecretsRepo(db, crypto.randomBytes(32));
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const app = Fastify();
  registerSecretsRoutes(app, { secrets });
  return { app, projectId: p.id };
}

describe('secrets routes', () => {
  it('PUT upserts, GET lists names, DELETE removes', async () => {
    const { app, projectId } = setup();
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/secrets/API_KEY`,
      payload: { value: 'abc' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/secrets/OTHER`,
      payload: { value: 'xyz' },
    });
    const list = (await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/secrets`,
    })).json() as Array<{ name: string }>;
    expect(list.map((s) => s.name).sort()).toEqual(['API_KEY', 'OTHER']);
    expect(JSON.stringify(list)).not.toContain('abc');
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/secrets/OTHER`,
    });
    expect(del.statusCode).toBe(204);
  });
});
