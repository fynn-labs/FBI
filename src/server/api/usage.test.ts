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

function setup() {
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
  registerUsageRoutes(app, { usage });
  return { app, runs, usage, runId: run.id };
}

describe('GET /api/usage/rate-limit', () => {
  it('returns a null-shape when nothing observed', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'GET', url: '/api/usage/rate-limit' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.observed_at).toBeNull();
    expect(body.percent_used).toBeNull();
  });

  it('returns derived fields when a snapshot exists', async () => {
    const { app, usage, runId } = setup();
    const now = Date.now();
    usage.upsertRateLimitState({
      observed_at: now, observed_from_run_id: runId,
      snapshot: {
        requests_remaining: 50, requests_limit: 200,
        tokens_remaining: null, tokens_limit: null,
        reset_at: now + 1800_000,
      },
    });
    const r = await app.inject({ method: 'GET', url: '/api/usage/rate-limit' });
    const body = r.json();
    expect(body.percent_used).toBeCloseTo(0.75, 2);
    expect(body.reset_in_seconds).toBeGreaterThan(0);
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
