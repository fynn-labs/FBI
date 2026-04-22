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
  it('replays transcript and stays open for terminal runs (so a Continue can stream into it)', async () => {
    const { app, port, runId } = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${runId}/shell`);
    const chunks: Buffer[] = [];
    ws.on('message', (d) => chunks.push(d as Buffer));
    await new Promise<void>((r) => ws.once('open', () => r()));
    // Give the server a tick to send the replay payload.
    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(chunks).toString()).toContain('past-output');
    // Socket must still be open — a subsequent Continue would publish into
    // the same broadcaster and the client must still be subscribed.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await app.close();
  });

  it('forwards bytes published to a terminal runs broadcaster (continue-after-terminal)', async () => {
    const { app, port, runId } = await setup();

    // Grab the server's stream registry via a second app.close()-aware path:
    // The test's `setup` keeps its registry internal. We rebuild setup-equivalent
    // wiring so we own the RunStreamRegistry and can publish into it.
    // (Simpler path: re-run a minimal setup inline.)
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
    fs.writeFileSync(logPath, 'old-transcript');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStarted(run.id, 'c');
    runs.markFinished(run.id, { state: 'failed', error: 'boom' });

    const app2 = Fastify();
    await app2.register(fastifyWebsocket);
    registerWsRoute(app2, {
      runs, streams,
      orchestrator: { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} },
    });
    await app2.listen({ port: 0 });
    const addr = app2.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/runs/${run.id}/shell`);
    const chunks: Buffer[] = [];
    ws.on('message', (d) => chunks.push(d as Buffer));
    await new Promise<void>((r) => ws.once('open', () => r()));
    await new Promise((r) => setTimeout(r, 50));

    // Simulate a Continue firing: publish into the run's broadcaster.
    streams.getOrCreate(run.id).publish(Buffer.from('\n[fbi] continuing from session x\n'));
    await new Promise((r) => setTimeout(r, 100));

    const combined = Buffer.concat(chunks).toString();
    expect(combined).toContain('old-transcript');
    expect(combined).toContain('continuing from session');

    ws.close();
    await app2.close();
    await app.close();
  });

  it('forwards state frames as JSON text to live run subscribers', async () => {
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
    const logPath = path.join(dir, 'run2.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStarted(run.id, 'c1');
    // run is now 'running'

    const app2 = Fastify();
    await app2.register(fastifyWebsocket);
    const orchestrator = { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} };
    registerWsRoute(app2, { runs, streams, orchestrator });
    await app2.listen({ port: 0 });
    const address = app2.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const port2 = address.port;

    const ws2 = new WebSocket(`ws://127.0.0.1:${port2}/api/runs/${run.id}/shell`);
    const openPromise = new Promise<void>((resolve) => ws2.once('open', resolve));

    const frameReceived = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for state frame')), 2000);
      ws2.on('message', (data, isBinary) => {
        if (!isBinary) { clearTimeout(t); resolve((data as Buffer).toString('utf8')); }
      });
    });

    await openPromise;

    // Publish a state frame — StateBroadcaster will forward to the subscriber in ws.ts
    const stateBc = streams.getOrCreateState(run.id);
    const frame = {
      type: 'state' as const,
      state: 'awaiting_resume' as const,
      next_resume_at: 9999999,
      resume_attempts: 1,
      last_limit_reset_at: null,
    };
    stateBc.publish(frame);

    const raw = await frameReceived;
    const parsed = JSON.parse(raw) as typeof frame;
    expect(parsed.type).toBe('state');
    expect(parsed.state).toBe('awaiting_resume');
    expect(parsed.next_resume_at).toBe(9999999);

    ws2.close();
    await app2.close();
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
