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
  const app = Fastify();
  void app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2 },
  });
  registerUploadsRoutes(app, { runs, runsDir, draftUploadsDir });
  return { app, dir, runsDir, draftUploadsDir, runs, projects };
}

function makeRun(
  app: ReturnType<typeof setup>,
  state: 'queued' | 'running' | 'waiting' | 'succeeded' = 'waiting',
) {
  const proj = app.projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const run = app.runs.create({
    project_id: proj.id,
    prompt: 'hi',
    branch_hint: undefined,
    log_path_tmpl: (rid) => path.join(app.runsDir, `${rid}.log`),
  });
  if (state === 'running') {
    app.runs.markStartingFromQueued(run.id, 'fake-container');
    app.runs.markRunning(run.id);
  } else if (state === 'waiting') {
    app.runs.markStartingFromQueued(run.id, 'fake-container');
    app.runs.markRunning(run.id);
    app.runs.markWaiting(run.id);
  } else if (state === 'succeeded') {
    app.runs.markStartingFromQueued(run.id, 'fake-container');
    app.runs.markRunning(run.id);
    app.runs.markFinished(run.id, { state: 'succeeded', exit_code: 0, branch_name: null, head_commit: null });
  }
  return app.runs.get(run.id)!;
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

describe('POST /api/runs/:id/uploads', () => {
  it('writes the file when state is waiting', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    const res = await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('hi'));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { filename: string }).filename).toBe('foo.csv');
    const written = fs.readFileSync(path.join(s.runsDir, String(run.id), 'uploads', 'foo.csv'), 'utf8');
    expect(written).toBe('hi');
  });

  it('writes the file when state is running (allows queued-prompt uploads)', async () => {
    const s = setup();
    const run = makeRun(s, 'running');
    const res = await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('hi'));
    expect(res.statusCode).toBe(200);
    const written = fs.readFileSync(path.join(s.runsDir, String(run.id), 'uploads', 'foo.csv'), 'utf8');
    expect(written).toBe('hi');
  });

  it('returns 409 when state is succeeded', async () => {
    const s = setup();
    const run = makeRun(s, 'succeeded');
    const res = await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('hi'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'wrong_state' });
  });

  it('returns 404 when the run does not exist', async () => {
    const s = setup();
    const res = await injectMultipart(s.app, '/api/runs/999999/uploads', 'foo.csv', Buffer.from('hi'));
    expect(res.statusCode).toBe(404);
  });

  it('returns 413 when the cumulative quota is exceeded', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    const dir = path.join(s.runsDir, String(run.id), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const big = path.join(dir, 'big.bin');
    const fd = fs.openSync(big, 'w');
    fs.ftruncateSync(fd, 1024 * 1024 * 1024 - 10);
    fs.closeSync(fd);
    const res = await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('more-than-10-bytes'));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'run_quota_exceeded' });
  });

  it('appends a one-line upload marker to the run log', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('hello'));
    const log = fs.readFileSync(path.join(s.runsDir, `${run.id}.log`), 'utf8');
    expect(log).toContain('[fbi] user uploaded foo.csv');
  });
});

describe('GET /api/runs/:id/uploads', () => {
  it('lists files alphabetically', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'b.txt', Buffer.from('b'));
    await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'a.txt', Buffer.from('a'));
    const res = await s.app.inject({ method: 'GET', url: `/api/runs/${run.id}/uploads` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: Array<{ filename: string }> };
    expect(body.files.map(f => f.filename)).toEqual(['a.txt', 'b.txt']);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    const res = await s.app.inject({ method: 'GET', url: `/api/runs/${run.id}/uploads` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { files: unknown[] }).files).toEqual([]);
  });
});

describe('DELETE /api/runs/:id/uploads/:filename', () => {
  it('removes the file when state is waiting', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('x'));
    const res = await s.app.inject({ method: 'DELETE', url: `/api/runs/${run.id}/uploads/foo.csv` });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(path.join(s.runsDir, String(run.id), 'uploads', 'foo.csv'))).toBe(false);
  });

  it('removes the file when state is running', async () => {
    const s = setup();
    const run = makeRun(s, 'running');
    const dir = path.join(s.runsDir, String(run.id), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'foo.csv'), 'x');
    const res = await s.app.inject({ method: 'DELETE', url: `/api/runs/${run.id}/uploads/foo.csv` });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(path.join(dir, 'foo.csv'))).toBe(false);
  });

  it('returns 409 when state is succeeded', async () => {
    const s = setup();
    const run = makeRun(s, 'succeeded');
    const dir = path.join(s.runsDir, String(run.id), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'foo.csv'), 'x');
    const res = await s.app.inject({ method: 'DELETE', url: `/api/runs/${run.id}/uploads/foo.csv` });
    expect(res.statusCode).toBe(409);
    expect(fs.existsSync(path.join(dir, 'foo.csv'))).toBe(true);
  });
});
