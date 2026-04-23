import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import FormData from 'form-data';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { LogStore } from '../logs/store.js';
import { registerUploadsRoutes } from './uploads.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-up-'));
  const runsDir = path.join(dir, 'runs');
  const draftUploadsDir = path.join(dir, 'draft-uploads');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(draftUploadsDir, { recursive: true });
  const db = openDb(path.join(dir, 'db.sqlite'));
  const runs = new RunsRepo(db);
  const projects = new ProjectsRepo(db);
  // LogStore takes a single file path string, not an options object
  const logs = new LogStore(path.join(runsDir, 'test.log'));
  const app = Fastify();
  void app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2 },
  });
  registerUploadsRoutes(app, { runs, runsDir, draftUploadsDir, logs });
  return { app, dir, runsDir, draftUploadsDir, runs, projects };
}

async function injectMultipart(
  app: Awaited<ReturnType<typeof setup>>['app'],
  url: string,
  filename: string,
  body: Buffer,
): Promise<import('light-my-request').Response> {
  const form = new FormData();
  form.append('file', body, { filename, contentType: 'application/octet-stream' });
  return app.inject({
    method: 'POST',
    url,
    headers: form.getHeaders(),
    payload: form.getBuffer(),
  });
}

describe('POST /api/draft-uploads', () => {
  it('creates a token and writes the file when no token is supplied', async () => {
    const { app, draftUploadsDir } = setup();
    const res = await injectMultipart(app, '/api/draft-uploads', 'foo.csv', Buffer.from('hello'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { draft_token: string; filename: string; size: number };
    expect(body.draft_token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.filename).toBe('foo.csv');
    expect(body.size).toBe(5);
    const written = fs.readFileSync(
      path.join(draftUploadsDir, body.draft_token, 'foo.csv'),
      'utf8',
    );
    expect(written).toBe('hello');
  });

  it('appends to an existing token and renames on collision', async () => {
    const { app, draftUploadsDir } = setup();
    const first = await injectMultipart(app, '/api/draft-uploads', 'foo.csv', Buffer.from('a'));
    const token = (first.json() as { draft_token: string }).draft_token;
    const second = await injectMultipart(
      app,
      `/api/draft-uploads?draft_token=${token}`,
      'foo.csv',
      Buffer.from('b'),
    );
    expect(second.statusCode).toBe(200);
    expect((second.json() as { filename: string }).filename).toBe('foo (1).csv');
    expect(fs.readdirSync(path.join(draftUploadsDir, token)).sort()).toEqual(
      ['foo (1).csv', 'foo.csv'],
    );
  });

  it('returns 400 on invalid filename', async () => {
    const { app } = setup();
    // Note: busboy normalizes "../etc/passwd" → "passwd" (valid), but
    // normalizes ".." → "" (empty), which sanitizeFilename correctly rejects.
    // Using ".." to test the invalid-filename path.
    const res = await injectMultipart(
      app,
      '/api/draft-uploads',
      '..',
      Buffer.from('x'),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_filename' });
  });
});

describe('DELETE /api/draft-uploads/:token/:filename', () => {
  it('removes the file', async () => {
    const { app, draftUploadsDir } = setup();
    const post = await injectMultipart(app, '/api/draft-uploads', 'foo.csv', Buffer.from('x'));
    const token = (post.json() as { draft_token: string }).draft_token;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/draft-uploads/${token}/foo.csv`,
    });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(path.join(draftUploadsDir, token, 'foo.csv'))).toBe(false);
  });

  it('returns 404 when the token is unknown', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/draft-uploads/00000000000000000000000000000000/foo.csv',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when the token is malformed', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/draft-uploads/bogus/foo.csv',
    });
    expect(res.statusCode).toBe(400);
  });
});
