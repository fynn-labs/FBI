import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { registerWsRoute } from './ws.js';
import type { RateLimitState } from '../../shared/types.js';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const streams = new RunStreamRegistry();
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const logPath = path.join(dir, 'run.log');
  fs.writeFileSync(logPath, 'past-output');
  const run = runs.create({
    project_id: p.id, prompt: 'hi',
    log_path_tmpl: () => logPath,
  });
  // Mark it finished so the WS just replays the transcript.
  runs.markStarted(run.id, 'c');
  runs.markFinished(run.id, { state: 'succeeded', exit_code: 0, head_commit: 'abc' });

  const app = Fastify();
  await app.register(fastifyWebsocket);
  const orchestrator = {
    writeStdin: () => {},
    resize: async () => {},
    cancel: async () => {},
  };
  registerWsRoute(app, { runs, streams, orchestrator });
  await app.listen({ port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { app, port: address.port, runId: run.id };
}

describe('WS shell', () => {
  it('replays transcript and closes for completed runs', async () => {
    const { app, port, runId } = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${runId}/shell`);
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on('message', (d) => chunks.push(d as Buffer));
      ws.on('close', () => resolve());
    });
    await done;
    expect(Buffer.concat(chunks).toString()).toContain('past-output');
    await app.close();
  });
});

describe('WS typed frames', () => {
  it('forwards usage and rate_limit events as JSON text frames', async () => {
    // Reuse setup() but mark the run as running (not finished) so the ws stays open.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const streams = new RunStreamRegistry();
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({
      project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath,
    });
    runs.markStarted(run.id, 'c');

    const app = Fastify();
    await app.register(fastifyWebsocket);
    const orchestrator = {
      writeStdin: () => {}, resize: async () => {}, cancel: async () => {},
    };
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);
    const messages: string[] = [];
    let resolve2!: () => void;
    const got2 = new Promise<void>((r) => { resolve2 = r; });
    let count = 0;
    ws.on('message', (d, isBinary) => {
      if (isBinary) return;
      messages.push(d.toString());
      if (++count >= 2) resolve2();
    });
    await new Promise((r) => ws.on('open', r));

    // Publish an event after a short delay.
    setTimeout(() => {
      const ev = streams.getOrCreateEvents(run.id);
      ev.publish({
        type: 'usage',
        snapshot: { model: 'claude-sonnet-4-6', input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_create_tokens: 0 },
      });
      const state: RateLimitState = {
        requests_remaining: 77, requests_limit: 200,
        tokens_remaining: null, tokens_limit: null, reset_at: null,
        observed_at: Date.now(), observed_from_run_id: run.id,
        percent_used: 0.615, reset_in_seconds: null, observed_seconds_ago: 0,
      };
      ev.publish({ type: 'rate_limit', snapshot: state });
    }, 50);

    // Wait until both frames arrive (or timeout on slow CI runners).
    await Promise.race([
      got2,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout waiting for frames')), 2000)),
    ]);
    const decoded = messages.map((m) => JSON.parse(m) as { type: string });
    expect(decoded.some((m) => m.type === 'usage')).toBe(true);
    expect(decoded.some((m) => m.type === 'rate_limit')).toBe(true);

    ws.close();
    await app.close();
  });
});
