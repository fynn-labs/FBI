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
