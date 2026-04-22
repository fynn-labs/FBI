import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCliRoutes } from './cli.js';

function withTempDir(setup: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-cli-'));
  setup(dir);
  return dir;
}

async function makeApp(opts: { cliDistDir: string; version?: string }): Promise<FastifyInstance> {
  const app = Fastify();
  registerCliRoutes(app, { cliDistDir: opts.cliDistDir, version: opts.version });
  await app.ready();
  return app;
}

describe('GET /api/cli/fbi-tunnel/:os/:arch', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it('streams the binary with the right headers', async () => {
    const dir = withTempDir((d) => {
      fs.writeFileSync(path.join(d, 'fbi-tunnel-darwin-arm64'), 'BINARY_CONTENTS');
    });
    app = await makeApp({ cliDistDir: dir, version: 'abc1234' });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/darwin/arm64' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="fbi-tunnel-darwin-arm64"');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['x-fbi-cli-version']).toBe('abc1234');
    expect(res.body).toBe('BINARY_CONTENTS');
  });

  it('omits X-FBI-CLI-Version when version is undefined', async () => {
    const dir = withTempDir((d) => {
      fs.writeFileSync(path.join(d, 'fbi-tunnel-linux-amd64'), 'X');
    });
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/linux/amd64' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-fbi-cli-version']).toBeUndefined();
  });

  it('returns 400 for an unsupported os', async () => {
    const dir = withTempDir(() => {});
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/windows/amd64' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unsupported os/arch' });
  });

  it('returns 400 for an unsupported arch', async () => {
    const dir = withTempDir(() => {});
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/linux/riscv' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for path-traversal attempts in os', async () => {
    const dir = withTempDir(() => {});
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/..%2Fetc/amd64' });
    // Fastify decodes %2F to "/" before matching, so this request actually
    // reaches the handler with os="../etc". The allowlist is the real defense —
    // it rejects anything outside {darwin, linux} with a 400.
    expect([400, 404]).toContain(res.statusCode);
  });

  it('returns 503 when the binary file is missing', async () => {
    const dir = withTempDir(() => {}); // empty dir
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/darwin/arm64' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'fbi-tunnel binary not built; rerun npm run build' });
  });
});
