import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import WebSocket from 'ws';
import fastifyWebsocket from '@fastify/websocket';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { registerProxyRoutes } from './proxy.js';

interface Container {
  inspect: () => Promise<{ State: { Pid: number }; NetworkSettings: { IPAddress: string; Networks?: Record<string, { IPAddress: string }> } }>;
}

function makeApp(opts: {
  runsRepo: RunsRepo;
  streams?: RunStreamRegistry;
  getLiveContainer: (runId: number) => Container | null;
  procReader?: (pid: number) => string;
}): Promise<FastifyInstance> {
  const app = Fastify();
  registerProxyRoutes(app, {
    runs: opts.runsRepo,
    streams: opts.streams ?? new RunStreamRegistry(),
    orchestrator: { getLiveContainer: opts.getLiveContainer as never },
    procReader: opts.procReader,
  });
  return Promise.resolve(app.ready()).then(() => app);
}

function setupRunsRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-proxy-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const make = () => runs.create({
    project_id: p.id, prompt: 'hi',
    log_path_tmpl: (id) => path.join(dir, `${id}.log`),
  });
  return { runs, make };
}

describe('GET /api/runs/:id/listening-ports', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it('returns 404 when run does not exist', async () => {
    const { runs } = setupRunsRepo();
    app = await makeApp({ runsRepo: runs, getLiveContainer: () => null });
    const res = await app.inject({ method: 'GET', url: '/api/runs/999/listening-ports' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when run exists but has no live container', async () => {
    const { runs, make } = setupRunsRepo();
    const run = make(); // queued, no container
    app = await makeApp({ runsRepo: runs, getLiveContainer: () => null });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/listening-ports` });
    expect(res.statusCode).toBe(409);
  });

  it('returns the parsed LISTEN ports for a running container', async () => {
    const { runs, make } = setupRunsRepo();
    const run = make();
    runs.markStarted(run.id, 'cid');
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 12345 },
        NetworkSettings: { IPAddress: '172.17.0.5' },
      }),
    };
    const procReader = vi.fn().mockReturnValue(
      `  sl  local_address rem_address   st ...
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 a 100 0 0 10 0
`,
    );
    app = await makeApp({
      runsRepo: runs,
      getLiveContainer: () => container,
      procReader,
    });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/listening-ports` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ports: [{ port: 5173, proto: 'tcp' }] });
    expect(procReader).toHaveBeenCalledWith(12345);
  });
});

async function makeWsApp(opts: {
  runsRepo: RunsRepo;
  streams: RunStreamRegistry;
  getLiveContainer: (runId: number) => Container | null;
  procReader?: (pid: number) => string;
}): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  registerProxyRoutes(app, {
    runs: opts.runsRepo,
    streams: opts.streams,
    orchestrator: { getLiveContainer: opts.getLiveContainer as never },
    procReader: opts.procReader,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { app, port: addr.port };
}

describe('WS /api/runs/:id/proxy/:port', () => {
  let app: FastifyInstance | null = null;
  let upstream: net.Server | null = null;
  afterEach(async () => {
    await app?.close(); app = null;
    if (upstream) { await new Promise<void>((r) => upstream!.close(() => r())); upstream = null; }
  });

  it('echoes bytes between WS and an upstream TCP socket', async () => {
    // Upstream echo server bound to a free port on localhost.
    const received = await new Promise<{ port: number }>((resolve) => {
      upstream = net.createServer((s) => s.on('data', (d) => s.write(d)));
      upstream.listen(0, '127.0.0.1', () => {
        const a = upstream!.address();
        if (!a || typeof a === 'string') throw new Error('no port');
        resolve({ port: a.port });
      });
    });

    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', state_entered_at: Date.now(), next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/${received.port}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

    const echoed = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      ws.on('message', (d, isBinary) => {
        if (!isBinary) return;
        chunks.push(d as Buffer);
        if (Buffer.concat(chunks).toString() === 'hello') resolve(Buffer.concat(chunks));
      });
      ws.send(Buffer.from('hello'), { binary: true });
    });
    expect(echoed.toString()).toBe('hello');
    ws.close();
  });

  it('closes WS with 1011 when upstream connect fails', async () => {
    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', state_entered_at: Date.now(), next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/1`); // port 1: refused
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1011);
  });

  it('closes WS with 1001 when run leaves running state', async () => {
    const received = await new Promise<{ port: number }>((resolve) => {
      upstream = net.createServer((s) => s.on('data', () => { /* swallow */ }));
      upstream.listen(0, '127.0.0.1', () => {
        const a = upstream!.address();
        if (!a || typeof a === 'string') throw new Error('no port');
        resolve({ port: a.port });
      });
    });
    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', state_entered_at: Date.now(), next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/${received.port}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'succeeded', state_entered_at: Date.now(), next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1001);
  });

  it('stays open when run transitions to waiting (container still alive)', async () => {
    const received = await new Promise<{ port: number }>((resolve) => {
      upstream = net.createServer((s) => s.on('data', (d) => s.write(d)));
      upstream.listen(0, '127.0.0.1', () => {
        const a = upstream!.address();
        if (!a || typeof a === 'string') throw new Error('no port');
        resolve({ port: a.port });
      });
    });
    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/${received.port}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

    // Transition to 'waiting' — container is still alive, tunnel must stay open.
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'waiting', next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });

    // Race a close event against an echo round-trip. The tunnel staying open
    // is proved by a successful echo *after* the waiting frame has published.
    const closed = new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    const echoed = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      ws.on('message', (d, isBinary) => {
        if (!isBinary) return;
        chunks.push(d as Buffer);
        if (Buffer.concat(chunks).toString() === 'hello') resolve(Buffer.concat(chunks));
      });
      ws.send(Buffer.from('hello'), { binary: true });
    });
    const winner = await Promise.race([
      echoed.then((b) => ({ kind: 'echo' as const, b })),
      closed.then((c) => ({ kind: 'close' as const, c })),
    ]);
    expect(winner.kind).toBe('echo');
    ws.close();
  });

  it('closes WS with 1001 when run goes to awaiting_resume', async () => {
    const received = await new Promise<{ port: number }>((resolve) => {
      upstream = net.createServer((s) => s.on('data', () => { /* swallow */ }));
      upstream.listen(0, '127.0.0.1', () => {
        const a = upstream!.address();
        if (!a || typeof a === 'string') throw new Error('no port');
        resolve({ port: a.port });
      });
    });
    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', state_entered_at: Date.now(), next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/${received.port}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'awaiting_resume', state_entered_at: Date.now(), next_resume_at: 0, resume_attempts: 1, last_limit_reset_at: 0 });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1001);
  });

  it('does not leak the state listener on a closed/already-non-running run', async () => {
    const received = await new Promise<{ port: number }>((resolve) => {
      upstream = net.createServer((s) => s.on('data', () => { /* swallow */ }));
      upstream.listen(0, '127.0.0.1', () => {
        const a = upstream!.address();
        if (!a || typeof a === 'string') throw new Error('no port');
        resolve({ port: a.port });
      });
    });
    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    // Publish a non-running frame BEFORE the WS connects, so the synchronous
    // replay during subscribe should fire closeBoth and uninstall the listener.
    streams.getOrCreateState(run.id).publish({
      type: 'state', state: 'succeeded',
      state_entered_at: Date.now(), next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/${received.port}`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1001);

    // Re-publish the same non-running state. If the listener leaked, calling
    // publish would still find it in subscribers — we can't easily observe that
    // directly, but we can check that no exception is thrown and the
    // broadcaster's subscriber count is 0.
    const bc = streams.getOrCreateState(run.id);
    bc.publish({
      type: 'state', state: 'failed',
      state_entered_at: Date.now(), next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });
    const subsField = (bc as unknown as { subs: Set<unknown> }).subs;
    expect(subsField.size).toBe(0);
  });
});
