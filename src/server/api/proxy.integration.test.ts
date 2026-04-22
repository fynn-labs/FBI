import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
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
import { registerProxyRoutes } from './proxy.js';

async function dockerAvailable(): Promise<boolean> {
  try { await new Docker().ping(); return true; } catch { return false; }
}

describe('proxy integration (Docker-gated)', () => {
  it('discovers a port and tunnels an HTTP request through the WS', async () => {
    if (!(await dockerAvailable())) return;
    const docker = new Docker();

    // Start a tiny HTTP server inside an alpine container on port 8000.
    const container = await docker.createContainer({
      Image: 'python:3-alpine',
      Cmd: ['python3', '-m', 'http.server', '8000'],
      HostConfig: { AutoRemove: false },
    });
    try {
      await container.start();

      // Repo plumbing for the route.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-pi-'));
      const db = openDb(path.join(dir, 'db.sqlite'));
      const projects = new ProjectsRepo(db);
      const runs = new RunsRepo(db);
      const streams = new RunStreamRegistry();
      const p = projects.create({
        name: 'p', repo_url: 'r', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null,
      });
      const run = runs.create({
        project_id: p.id, prompt: 'hi',
        log_path_tmpl: (id) => path.join(dir, `${id}.log`),
      });
      runs.markStarted(run.id, container.id);
      streams.getOrCreateState(run.id).publish({
        type: 'state', state: 'running',
        next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
      });

      const app = Fastify();
      await app.register(fastifyWebsocket);
      registerProxyRoutes(app, {
        runs, streams,
        orchestrator: { getLiveContainer: () => container as never },
      });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const port = addr.port;

      // Wait briefly for python http.server to bind.
      for (let i = 0; i < 20; i++) {
        const r = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/listening-ports`);
        const body = await r.json() as { ports: { port: number }[] };
        if (body.ports.some((p2) => p2.port === 8000)) break;
        await new Promise((r2) => setTimeout(r2, 250));
      }

      // Now tunnel an HTTP/1.1 GET / through the WS.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${run.id}/proxy/8000`);
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      const response = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        ws.on('message', (d, isBinary) => {
          if (!isBinary) return;
          chunks.push(d as Buffer);
          const buf = Buffer.concat(chunks).toString();
          if (buf.includes('\r\n\r\n')) resolve(buf);
        });
        ws.send(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'), { binary: true });
      });
      ws.close();
      await app.close();

      expect(response.startsWith('HTTP/1.0 200') || response.startsWith('HTTP/1.1 200')).toBe(true);
    } finally {
      await container.remove({ force: true, v: true }).catch(() => {});
    }
  }, 60_000);
});
