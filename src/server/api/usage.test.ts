import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { UsageRepo } from '../db/usage.js';
import { registerUsageRoutes } from './usage.js';
import type { UsageState } from '../../shared/types.js';

const DEFAULT_SNAPSHOT: UsageState = {
  plan: null, observed_at: null, last_error: null, last_error_at: null,
  buckets: [], pacing: {},
};

function setup(opts: { pollerSnapshot?: () => UsageState } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-usage-api-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const usage = new UsageRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const run = runs.create({
    project_id: p.id, prompt: 'hi',
    log_path_tmpl: (id) => `/tmp/${id}.log`,
  });
  const app = Fastify();
  const pollerSnapshot = opts.pollerSnapshot ?? (() => DEFAULT_SNAPSHOT);
  registerUsageRoutes(app, { usage, pollerSnapshot });
  return { app, runs, usage, runId: run.id };
}

describe('GET /api/usage', () => {
  it('returns the poller snapshot', async () => {
    const snap: UsageState = {
      plan: 'max', observed_at: 1000, last_error: null, last_error_at: null,
      buckets: [{ id: 'five_hour', utilization: 0.5, reset_at: 5000, window_started_at: 1000 }],
      pacing: { five_hour: { delta: 0, zone: 'on_track' } },
    };
    const { app } = setup({ pollerSnapshot: () => snap });
    const r = await app.inject({ method: 'GET', url: '/api/usage' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(snap);
  });

  it('returns a neutral snapshot when nothing observed yet', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'GET', url: '/api/usage' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.plan).toBeNull();
    expect(body.observed_at).toBeNull();
    expect(body.last_error).toBeNull();
    expect(Array.isArray(body.buckets)).toBe(true);
    expect(body.buckets).toHaveLength(0);
  });

  it('GET /api/usage/rate-limit is no longer registered', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'GET', url: '/api/usage/rate-limit' });
    expect(r.statusCode).toBe(404);
  });
});

describe('GET /api/usage/daily', () => {
  it('returns rows with valid shape; clamps days', async () => {
    const { app, usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId, ts: Date.now(),
      snapshot: { model: 'claude-sonnet-4-6', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    const r = await app.inject({ method: 'GET', url: '/api/usage/daily?days=14' });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);

    const clamped = await app.inject({ method: 'GET', url: '/api/usage/daily?days=1000' });
    expect(clamped.statusCode).toBe(200);
  });
});

describe('GET /api/usage/runs/:id', () => {
  it('returns [] for a run with no events', async () => {
    const { app, runId } = setup();
    const r = await app.inject({ method: 'GET', url: `/api/usage/runs/${runId}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('returns per-model breakdown', async () => {
    const { app, usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId, ts: 1,
      snapshot: { model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    const r = await app.inject({ method: 'GET', url: `/api/usage/runs/${runId}` });
    const body = r.json() as Array<{ model: string; input: number }>;
    expect(body.length).toBe(1);
    expect(body[0].model).toBe('claude-sonnet-4-6');
    expect(body[0].input).toBe(10);
  });
});
