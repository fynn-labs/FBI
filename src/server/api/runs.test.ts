import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import FormData from 'form-data';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { registerRunsRoutes } from './runs.js';
import { registerUploadsRoutes } from './uploads.js';

const stubGh = {
  available: async () => true,
  prForBranch: async () => null,
  prChecks: async () => [],
  createPr: async () => ({ number: 1, url: 'u', state: 'OPEN' as const, title: 't' }),
  compareFiles: async () => [],
  commitsOnBranch: async () => [],
  mergeBranch: async () => ({ merged: false as const, reason: 'gh-error' as const }),
};

const stubOrchestrator = {
  writeStdin: (_runId: number, _bytes: Uint8Array) => { /* noop */ },
  getLastFiles: (_runId: number) => null,
  execInContainer: async (_runId: number, _cmd: string[], _opts?: { timeoutMs?: number }) => {
    throw new Error('container not active');
  },
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
  const streams = new RunStreamRegistry();
  registerRunsRoutes(app, {
    runs, projects, gh: stubGh,
    streams,
    runsDir: dir,
    draftUploadsDir: dir,
    launch: async (id: number) => {
      launched.push(id);
    },
    cancel: async (id: number) => {
      cancelled.push(id);
    },
    fireResumeNow: (_id: number) => {},
    continueRun: async (_id: number) => {},
    orchestrator: stubOrchestrator,
  });
  return { app, projectId: p.id, launched, cancelled, streams, runs };
}

function setupWithUploads() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const runsDir = path.join(dir, 'runs');
  const draftUploadsDir = path.join(dir, 'draft-uploads');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(draftUploadsDir, { recursive: true });
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const launched: number[] = [];
  const app = Fastify();
  void app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2 },
  });
  registerRunsRoutes(app, {
    runs, projects, gh: stubGh,
    streams: new RunStreamRegistry(),
    runsDir,
    draftUploadsDir,
    launch: async (id: number) => { launched.push(id); },
    cancel: async (_id: number) => {},
    fireResumeNow: (_id: number) => {},
    continueRun: async (_id: number) => {},
    orchestrator: stubOrchestrator,
  });
  registerUploadsRoutes(app, { runs, runsDir, draftUploadsDir });
  return { app, projectId: p.id, launched, runs, runsDir, draftUploadsDir };
}

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const app = Fastify();
  const streams = new RunStreamRegistry();
  registerRunsRoutes(app, {
    runs, projects, gh: stubGh,
    streams,
    runsDir: dir,
    draftUploadsDir: dir,
    launch: async (_id: number) => {},
    cancel: async (_id: number) => {},
    fireResumeNow: (_id: number) => {},
    continueRun: async (_id: number) => {},
    orchestrator: stubOrchestrator,
  });
  return { app, projects, runs, streams };
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

  it('POST /api/runs/:id/resume-now returns 404 for unknown run', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/runs/9999/resume-now' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/runs/:id/resume-now returns 409 when run is not awaiting_resume', async () => {
    const { app, projectId } = setup();
    const r = (await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/runs`, payload: { prompt: 'x' },
    })).json() as { id: number };
    // run is 'queued', not 'awaiting_resume'
    const res = await app.inject({ method: 'POST', url: `/api/runs/${r.id}/resume-now` });
    expect(res.statusCode).toBe(409);
  });

  it('POST /api/runs/:id/resume-now returns 204 and fires for awaiting_resume run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
    const r = runs.create({ project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.markStarted(r.id, 'c1');
    runs.markAwaitingResume(r.id, { next_resume_at: Date.now() + 60_000, last_limit_reset_at: null });
    const fired: number[] = [];
    const app2 = Fastify();
    registerRunsRoutes(app2, {
      runs, projects, gh: stubGh,
      streams: new RunStreamRegistry(),
      runsDir: dir,
      draftUploadsDir: dir,
      launch: async (_id: number) => {},
      cancel: async (_id: number) => {},
      fireResumeNow: (id: number) => { fired.push(id); },
      continueRun: async (_id: number) => {},
    orchestrator: stubOrchestrator,
    });
    const res = await app2.inject({ method: 'POST', url: `/api/runs/${r.id}/resume-now` });
    expect(res.statusCode).toBe(204);
    expect(fired).toEqual([r.id]);
  });

  it('POST /api/runs/:id/continue returns 404 for unknown run', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/runs/9999/continue' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/runs/:id/continue forwards to the orchestrator and returns 204', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const proj = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: proj.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(dir, `${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.setClaudeSessionId(run.id, 'sess');
    runs.markFinished(run.id, { state: 'failed' });
    // Plant a session jsonl so the handler's eligibility check passes.
    const sessDir = path.join(dir, String(run.id), 'claude-projects');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'sess.jsonl'), '{"x":1}\n');

    const continued: number[] = [];
    const app = Fastify();
    registerRunsRoutes(app, {
      runs, projects, gh: stubGh, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
      launch: async () => {}, cancel: async () => {},
      fireResumeNow: () => {},
      continueRun: async (id: number) => { continued.push(id); },
      orchestrator: stubOrchestrator,
    });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/continue` });
    expect(res.statusCode).toBe(204);
    // Allow the fire-and-forget microtask to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(continued).toEqual([run.id]);
  });

  it('POST /api/runs/:id/continue returns 204 without waiting for the run to finish (fire-and-forget)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const proj = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: proj.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(dir, `${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.setClaudeSessionId(run.id, 'sess');
    runs.markFinished(run.id, { state: 'failed' });
    const sessDir = path.join(dir, String(run.id), 'claude-projects');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'sess.jsonl'), '{"x":1}\n');

    // continueRun simulates a long-running container lifecycle — it never
    // resolves within the test window.
    let resolveContinue!: () => void;
    const longContinue = new Promise<void>((r) => { resolveContinue = r; });
    const app = Fastify();
    registerRunsRoutes(app, {
      runs, projects, gh: stubGh, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
      launch: async () => {}, cancel: async () => {},
      fireResumeNow: () => {},
      continueRun: () => longContinue,
      orchestrator: stubOrchestrator,
    });
    const start = Date.now();
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/continue` });
    const elapsed = Date.now() - start;
    expect(res.statusCode).toBe(204);
    // Must not have waited for the long-running promise.
    expect(elapsed).toBeLessThan(500);
    resolveContinue();
  });

  describe('PATCH /api/runs/:id', () => {
    function setupWithRun() {
      const { app, projects, runs, streams } = makeApp();
      const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
        devcontainer_override_json: null, instructions: null, git_author_name: null, git_author_email: null });
      const run = runs.create({ project_id: p.id, prompt: 'hi',
        log_path_tmpl: (id) => `/tmp/${id}.log` });
      return { app, runs, run, streams };
    }
    it('updates title and sets the lock', async () => {
      const { app, run } = setupWithRun();
      const res = await app.inject({ method: 'PATCH', url: `/api/runs/${run.id}`, payload: { title: '  New name  ' } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.title).toBe('New name');
      expect(body.title_locked).toBe(1);
    });
    it('publishes a title frame on rename', async () => {
      const { app, run, streams } = setupWithRun();
      const received: unknown[] = [];
      streams.getOrCreateEvents(run.id).subscribe((msg) => received.push(msg));
      const res = await app.inject({ method: 'PATCH', url: `/api/runs/${run.id}`, payload: { title: 'Renamed' } });
      expect(res.statusCode).toBe(200);
      expect(received).toEqual([{ type: 'title', title: 'Renamed', title_locked: 1 }]);
    });
    it('returns 404 for unknown run', async () => {
      const { app } = setupWithRun();
      const res = await app.inject({ method: 'PATCH', url: '/api/runs/99999', payload: { title: 'x' } });
      expect(res.statusCode).toBe(404);
    });
    it('rejects empty title after trim', async () => {
      const { app, run } = setupWithRun();
      const res = await app.inject({ method: 'PATCH', url: `/api/runs/${run.id}`, payload: { title: '   ' } });
      expect(res.statusCode).toBe(400);
    });
    it('rejects titles longer than 120 chars', async () => {
      const { app, run } = setupWithRun();
      const res = await app.inject({ method: 'PATCH', url: `/api/runs/${run.id}`, payload: { title: 'x'.repeat(121) } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/runs/:id/files', () => {
    it('returns the orchestrator snapshot when live', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
      const db = openDb(path.join(dir, 'db.sqlite'));
      const projects = new ProjectsRepo(db);
      const runs = new RunsRepo(db);
      const p = projects.create({ name: 'p', repo_url: 'https://github.com/me/foo.git', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null });
      const r = runs.create({ project_id: p.id, prompt: 'x', branch_hint: 'feat/x', log_path_tmpl: (id) => `/tmp/${id}.log` });
      runs.markStarted(r.id, 'c');

      const snap = {
        dirty: [{ path: 'a.ts', status: 'M' as const, additions: 1, deletions: 0 }],
        head: null, headFiles: [], branchBase: null, live: true,
      };
      const app = Fastify();
      registerRunsRoutes(app, {
        runs, projects, gh: stubGh, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
        launch: async () => {}, cancel: async () => {},
        fireResumeNow: () => {}, continueRun: async () => {},
        orchestrator: { ...stubOrchestrator, getLastFiles: () => snap },
      });
      const res = await app.inject({ method: 'GET', url: `/api/runs/${r.id}/files` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(snap);
    });

    it('falls back to gh compare when no live container', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
      const db = openDb(path.join(dir, 'db.sqlite'));
      const projects = new ProjectsRepo(db);
      const runs = new RunsRepo(db);
      const p = projects.create({ name: 'p', repo_url: 'https://github.com/me/foo.git', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null });
      const r = runs.create({ project_id: p.id, prompt: 'x', branch_hint: 'feat/x', log_path_tmpl: (id) => `/tmp/${id}.log` });
      runs.markStarted(r.id, 'c');
      runs.markFinished(r.id, { state: 'succeeded', branch_name: 'feat/x' });
      const app = Fastify();
      registerRunsRoutes(app, {
        runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
        launch: async () => {}, cancel: async () => {},
        fireResumeNow: () => {}, continueRun: async () => {},
        gh: { ...stubGh,
          compareFiles: async () => [{ filename: 'x.ts', additions: 3, deletions: 1, status: 'modified' }],
        },
        orchestrator: stubOrchestrator,
      });
      const res = await app.inject({ method: 'GET', url: `/api/runs/${r.id}/files` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { headFiles: Array<{ path: string; status: string }>; live: boolean };
      expect(body.live).toBe(false);
      expect(body.headFiles[0]).toMatchObject({ path: 'x.ts', status: 'M' });
    });
  });

  describe('POST /api/runs/:id/github/merge', () => {
    function setupRun(state: 'running' | 'succeeded') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
      const db = openDb(path.join(dir, 'db.sqlite'));
      const projects = new ProjectsRepo(db);
      const runs = new RunsRepo(db);
      const p = projects.create({ name: 'p', repo_url: 'https://github.com/me/foo.git', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null });
      const r = runs.create({ project_id: p.id, prompt: 'x', branch_hint: 'feat/x', log_path_tmpl: (id) => `/tmp/${id}.log` });
      runs.markStarted(r.id, 'c');
      if (state === 'succeeded') runs.markFinished(r.id, { state: 'succeeded', branch_name: 'feat/x' });
      return { dir, projects, runs, run: runs.get(r.id)! };
    }

    it('fast path: returns merged:true on gh success', async () => {
      const { dir, projects, runs, run } = setupRun('succeeded');
      const app = Fastify();
      registerRunsRoutes(app, {
        runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
        launch: async () => {}, cancel: async () => {},
        fireResumeNow: () => {}, continueRun: async () => {},
        gh: { ...stubGh, mergeBranch: async () => ({ merged: true as const, sha: 'deadbeef' }) },
        orchestrator: stubOrchestrator,
      });
      const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/github/merge` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: true, sha: 'deadbeef' });
    });

    it('conflict + running: delegates to agent via writeStdin', async () => {
      const { dir, projects, runs, run } = setupRun('running');
      const writes: Array<{ runId: number; text: string }> = [];
      const app = Fastify();
      registerRunsRoutes(app, {
        runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
        launch: async () => {}, cancel: async () => {},
        fireResumeNow: () => {}, continueRun: async () => {},
        gh: { ...stubGh, mergeBranch: async () => ({ merged: false as const, reason: 'conflict' as const }) },
        orchestrator: {
          ...stubOrchestrator,
          writeStdin: (runId, bytes) => writes.push({ runId, text: Buffer.from(bytes).toString('utf8') }),
        },
      });
      const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/github/merge` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: false, reason: 'conflict', agent: true });
      expect(writes).toHaveLength(1);
      expect(writes[0].text).toMatch(/Merge branch feat\/x/);
    });

    it('conflict + succeeded: returns 409 agent-busy', async () => {
      const { dir, projects, runs, run } = setupRun('succeeded');
      const app = Fastify();
      registerRunsRoutes(app, {
        runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
        launch: async () => {}, cancel: async () => {},
        fireResumeNow: () => {}, continueRun: async () => {},
        gh: { ...stubGh, mergeBranch: async () => ({ merged: false as const, reason: 'conflict' as const }) },
        orchestrator: stubOrchestrator,
      });
      const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/github/merge` });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ merged: false, reason: 'agent-busy' });
    });
  });

  it('POST /api/runs/:id/continue returns 409 with code when ineligible', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const proj = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: proj.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(dir, `${id}.log`),
    });
    // Run is `failed` but has no claude_session_id captured.
    runs.markStarted(run.id, 'c1');
    runs.markFinished(run.id, { state: 'failed' });
    const app = Fastify();
    registerRunsRoutes(app, {
      runs, projects, gh: stubGh, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
      launch: async () => {}, cancel: async () => {},
      fireResumeNow: () => {},
      continueRun: async () => { throw new Error('should not be called'); },
      orchestrator: stubOrchestrator,
    });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/continue` });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe('no_session');
    expect(body.message).toMatch(/session/i);
  });

  describe('POST /api/projects/:id/runs — model params', () => {
    it('persists model, effort, subagent_model when provided', async () => {
      const { app, projectId, runs } = setup();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs`,
        payload: {
          prompt: 'do thing',
          model: 'opus',
          effort: 'xhigh',
          subagent_model: 'sonnet',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: number };
      const row = runs.get(body.id)!;
      expect(row.model).toBe('opus');
      expect(row.effort).toBe('xhigh');
      expect(row.subagent_model).toBe('sonnet');
    });

    it('stores NULLs when model params are omitted', async () => {
      const { app, projectId, runs } = setup();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs`,
        payload: { prompt: 'do thing' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: number };
      const row = runs.get(body.id)!;
      expect(row.model).toBeNull();
      expect(row.effort).toBeNull();
      expect(row.subagent_model).toBeNull();
    });

    it('returns 400 on invalid model', async () => {
      const { app, projectId } = setup();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs`,
        payload: { prompt: 'x', model: 'turbo' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 on effort + haiku', async () => {
      const { app, projectId } = setup();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs`,
        payload: { prompt: 'x', model: 'haiku', effort: 'high' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 on xhigh + sonnet', async () => {
      const { app, projectId } = setup();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs`,
        payload: { prompt: 'x', model: 'sonnet', effort: 'xhigh' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('draft_token integration', () => {
    it('POST /api/projects/:id/runs with draft_token promotes uploads and still launches', async () => {
      const { app, projectId, launched, runsDir } = setupWithUploads();

      // Upload a draft file.
      const form = new FormData();
      form.append('file', Buffer.from('hi'), { filename: 'foo.csv' });
      const up = await app.inject({
        method: 'POST', url: '/api/draft-uploads',
        headers: form.getHeaders(), payload: form.getBuffer(),
      });
      expect(up.statusCode).toBe(200);
      const draft_token = (up.json() as { draft_token: string }).draft_token;

      // Create the run with the token.
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs`,
        payload: { prompt: 'hi', draft_token },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: number };
      expect(launched).toEqual([body.id]);

      // File landed in the run's uploads dir.
      expect(fs.existsSync(
        path.join(runsDir, String(body.id), 'uploads', 'foo.csv'),
      )).toBe(true);
    });

    it('POST with an unknown draft_token returns 422 and does not create a run', async () => {
      const { app, projectId, launched, runs } = setupWithUploads();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs`,
        payload: { prompt: 'hi', draft_token: 'f'.repeat(32) },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'promotion_failed' });
      expect(launched).toEqual([]);
      expect(runs.listAll().length).toBe(0);
    });

    it('POST with a malformed draft_token returns 400', async () => {
      const { app, projectId, launched } = setupWithUploads();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/runs`,
        payload: { prompt: 'hi', draft_token: 'bogus' },
      });
      expect(res.statusCode).toBe(400);
      expect(launched).toEqual([]);
    });
  });
});
