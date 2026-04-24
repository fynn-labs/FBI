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
  runs.markStartingFromQueued(run.id, 'c');
  runs.markRunning(run.id);
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
    // Send hello so the server emits its opening snapshot.
    ws.send(JSON.stringify({ type: 'hello', cols: 120, rows: 40 }));
    // Wait for the snapshot to arrive (hello gate resolves immediately).
    await new Promise((r) => setTimeout(r, 200));
    expect(Buffer.concat(chunks).toString()).toContain('past-output');
    // Socket must still be open — a subsequent Continue would publish into
    // the same broadcaster and the client must still be subscribed.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await app.close();
  });

  it('forwards bytes published to a terminal runs broadcaster (continue-after-terminal)', async () => {
    const { app } = await setup();

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
    runs.markStartingFromQueued(run.id, 'c');
    runs.markRunning(run.id);
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
    // Send hello so the server emits its opening snapshot and sets live=true.
    ws.send(JSON.stringify({ type: 'hello', cols: 120, rows: 40 }));
    await new Promise((r) => setTimeout(r, 200));

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
    runs.markStartingFromQueued(run.id, 'c1');
    runs.markRunning(run.id);
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
        if (isBinary) return;
        const text = (data as Buffer).toString('utf8');
        const parsed = JSON.parse(text) as { type: string };
        if (parsed.type === 'snapshot') return; // skip snapshot frames
        clearTimeout(t);
        resolve(text);
      });
    });

    await openPromise;

    // Publish a state frame — StateBroadcaster will forward to the subscriber in ws.ts
    const stateBc = streams.getOrCreateState(run.id);
    const frame = {
      type: 'state' as const,
      state: 'awaiting_resume' as const,
      state_entered_at: Date.now(),
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

describe('WS global state channel', () => {
  it('forwards global state frames on /api/ws/states', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-gs-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const streams = new RunStreamRegistry();
    const app = Fastify();
    await app.register(fastifyWebsocket);
    const orchestrator = { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} };
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') { await app.close(); throw new Error('no port'); }

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/ws/states`);
    const frames: string[] = [];
    const firstMessage = new Promise<void>((resolve) => {
      ws.on('message', (d) => { frames.push((d as Buffer).toString('utf8')); resolve(); });
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    streams.getGlobalStates().publish({
      type: 'state',
      run_id: 42,
      project_id: 7,
      state: 'waiting',
      state_entered_at: Date.now(),
      next_resume_at: null,
      resume_attempts: 0,
      last_limit_reset_at: null,
    });

    await Promise.race([
      firstMessage,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout waiting for global state frame')), 2000)),
    ]);
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0]);
    expect(parsed.type).toBe('state');
    expect(parsed.run_id).toBe(42);
    expect(parsed.project_id).toBe(7);
    expect(parsed.state).toBe('waiting');

    ws.close();
    await app.close();
  });
});

describe('WS snapshot handshake', () => {
  it('sends a snapshot text frame as the first message on active-run connect', async () => {
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
    const logPath = path.join(dir, 'run-snap.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStartingFromQueued(run.id, 'c1');
    runs.markRunning(run.id);
    // run is now 'running'

    // Pre-populate a ScreenState so the route has something to serialize.
    const screen = streams.getOrCreateScreen(run.id, 80, 24);
    await screen.write(new TextEncoder().encode('hello world\r\n'));

    const app = Fastify();
    await app.register(fastifyWebsocket);
    const orchestrator = { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} };
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);

    const first = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for first frame')), 2000);
      ws.once('message', (data, isBinary) => {
        clearTimeout(t);
        if (isBinary) { reject(new Error('expected text frame, got binary')); return; }
        resolve((data as Buffer).toString('utf8'));
      });
    });

    const msg = JSON.parse(first) as { type: string; ansi: string; cols: number; rows: number };
    expect(msg.type).toBe('snapshot');
    expect(typeof msg.ansi).toBe('string');
    expect(msg.cols).toBe(80);
    expect(msg.rows).toBe(24);

    ws.close();
    await app.close();
  });

  it('does not send a snapshot frame in response to a resize message', async () => {
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
    const logPath = path.join(dir, 'run-noresize.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStartingFromQueued(run.id, 'c1');
    runs.markRunning(run.id);
    // run is now 'running'

    const screen = streams.getOrCreateScreen(run.id, 80, 24);
    await screen.write(new TextEncoder().encode('before\r\n'));

    const orchestrator = { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} };
    const app = Fastify();
    await app.register(fastifyWebsocket);
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);
    const textFrames: string[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) textFrames.push((data as Buffer).toString('utf8'));
    });
    await new Promise<void>((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', cols: 80, rows: 24 }));

    // Wait for the opening snapshot (frame #1).
    while (textFrames.length < 1) { await new Promise((r) => setTimeout(r, 20)); }
    expect(JSON.parse(textFrames[0]).type).toBe('snapshot');

    // Send a resize; wait 500 ms and assert no *additional* snapshot.
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await new Promise((r) => setTimeout(r, 500));
    expect(textFrames).toHaveLength(1);

    ws.close();
    await app.close();
  });

  it('defers the opening snapshot until the client sends hello', async () => {
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
    const logPath = path.join(dir, 'run-hello.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStartingFromQueued(run.id, 'c1');
    runs.markRunning(run.id);
    // Pre-create a screen so sendSnapshot doesn't go down the rebuild path.
    streams.getOrCreateScreen(run.id, 80, 24);

    const resizeCalls: Array<{ cols: number; rows: number }> = [];
    const orchestrator = {
      writeStdin: () => {},
      resize: async (_id: number, cols: number, rows: number) => {
        resizeCalls.push({ cols, rows });
      },
      cancel: async () => {},
    };

    const app = Fastify();
    await app.register(fastifyWebsocket);
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);
    await new Promise<void>((r) => ws.once('open', r));

    // Give the server 100 ms — if it were going to send a snapshot without
    // hello, it would have done so by now.
    const earlyFrames: string[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) earlyFrames.push((data as Buffer).toString('utf8'));
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(earlyFrames).toHaveLength(0);

    // Send hello. A snapshot should follow within 500 ms.
    ws.send(JSON.stringify({ type: 'hello', cols: 100, rows: 30 }));
    const snap = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('snapshot did not arrive')), 500);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        clearTimeout(t);
        resolve((data as Buffer).toString('utf8'));
      });
    });
    const parsed = JSON.parse(snap) as { type: string; cols: number; rows: number };
    expect(parsed.type).toBe('snapshot');
    expect(parsed.cols).toBe(100);
    expect(parsed.rows).toBe(30);
    expect(resizeCalls).toContainEqual({ cols: 100, rows: 30 });

    ws.close();
    await app.close();
  });

  it('falls back to a default-dims snapshot if hello never arrives within 1500 ms', async () => {
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
    const logPath = path.join(dir, 'run-fallback.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStartingFromQueued(run.id, 'c1');
    runs.markRunning(run.id);
    streams.getOrCreateScreen(run.id, 120, 40); // default dims

    const orchestrator = { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} };
    const app = Fastify();
    await app.register(fastifyWebsocket);
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);
    await new Promise<void>((r) => ws.once('open', r));

    // Do NOT send hello. Wait for the fallback.
    const snap = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('fallback snapshot did not arrive')), 3000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        clearTimeout(t);
        resolve((data as Buffer).toString('utf8'));
      });
    });
    const parsed = JSON.parse(snap) as { type: string; cols: number; rows: number };
    expect(parsed.type).toBe('snapshot');
    expect(parsed.cols).toBe(120);
    expect(parsed.rows).toBe(40);

    ws.close();
    await app.close();
  });
});

describe('WS typed frames', () => {
  it('forwards usage events as JSON text frames', async () => {
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
    runs.markStartingFromQueued(run.id, 'c');
    runs.markRunning(run.id);

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
    let resolve1!: () => void;
    const got1 = new Promise<void>((r) => { resolve1 = r; });
    ws.on('message', (d, isBinary) => {
      if (isBinary) return;
      const text = (d as Buffer).toString('utf8');
      const parsed = JSON.parse(text) as { type: string };
      if (parsed.type === 'snapshot') return; // skip snapshot frames
      messages.push(text);
      if (messages.length >= 1) resolve1();
    });
    await new Promise((r) => ws.on('open', r));

    // Publish an event after a short delay.
    setTimeout(() => {
      const ev = streams.getOrCreateEvents(run.id);
      ev.publish({
        type: 'usage',
        snapshot: { model: 'claude-sonnet-4-6', input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_create_tokens: 0 },
      });
    }, 50);

    // Wait until the frame arrives (or timeout on slow CI runners).
    await Promise.race([
      got1,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout waiting for frames')), 2000)),
    ]);
    const decoded = messages.map((m) => JSON.parse(m) as { type: string });
    expect(decoded.some((m) => m.type === 'usage')).toBe(true);

    ws.close();
    await app.close();
  });
});
