import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { openDb } from '../db/index.js';
import { McpServersRepo } from '../db/mcpServers.js';
import { ProjectsRepo } from '../db/projects.js';
import { registerMcpServerRoutes } from './mcpServers.js';

function tmpSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const mcpServers = new McpServersRepo(db);
  const projects = new ProjectsRepo(db);
  const app = Fastify();
  registerMcpServerRoutes(app, { mcpServers });
  return { app, mcpServers, projects };
}

describe('MCP server routes', () => {
  let setup: ReturnType<typeof tmpSetup>;

  beforeEach(() => {
    setup = tmpSetup();
  });

  it('POST /api/mcp-servers → 201 with created server', async () => {
    const res = await setup.app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      body: { name: 'puppeteer', type: 'stdio', command: 'npx', args: ['-y', '@mcp/puppeteer'] },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { name: string; id: number };
    expect(body.name).toBe('puppeteer');
    expect(body.id).toBeGreaterThan(0);
  });

  it('GET /api/mcp-servers → lists global servers', async () => {
    setup.mcpServers.create({ project_id: null, name: 'fetch', type: 'stdio', command: 'npx', args: [] });
    const res = await setup.app.inject({ method: 'GET', url: '/api/mcp-servers' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { name: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('fetch');
  });

  it('PATCH /api/mcp-servers/:id → updates and returns server', async () => {
    const s = setup.mcpServers.create({ project_id: null, name: 'mem', type: 'stdio', command: 'npx', args: [] });
    const res = await setup.app.inject({
      method: 'PATCH',
      url: `/api/mcp-servers/${s.id}`,
      body: { args: ['-y', 'updated'] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { args: string[] };
    expect(body.args).toEqual(['-y', 'updated']);
  });

  it('PATCH /api/mcp-servers/:id → 404 for nonexistent id', async () => {
    const res = await setup.app.inject({
      method: 'PATCH',
      url: '/api/mcp-servers/9999',
      body: { args: [] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /api/mcp-servers/:id → 204', async () => {
    const s = setup.mcpServers.create({ project_id: null, name: 'del', type: 'stdio', command: 'npx', args: [] });
    const res = await setup.app.inject({ method: 'DELETE', url: `/api/mcp-servers/${s.id}` });
    expect(res.statusCode).toBe(204);
    expect(setup.mcpServers.listGlobal()).toHaveLength(0);
  });

  it('DELETE /api/mcp-servers/:id → 404 for nonexistent id', async () => {
    const res = await setup.app.inject({ method: 'DELETE', url: '/api/mcp-servers/9999' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/projects/:id/mcp-servers → 201 scoped to project', async () => {
    const project = setup.projects.create({
      name: 'p1', repo_url: 'git@x.com:x/y.git', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const res = await setup.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/mcp-servers`,
      body: { name: 'github', type: 'stdio', command: 'npx', args: [] },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { project_id: number };
    expect(body.project_id).toBe(project.id);
  });

  it('PATCH /api/projects/:id/mcp-servers/:sid → 404 if sid belongs to different project', async () => {
    const p1 = setup.projects.create({
      name: 'p1', repo_url: 'git@x.com:x/y.git', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const p2 = setup.projects.create({
      name: 'p2', repo_url: 'git@x.com:x/z.git', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    // Create server for p1
    const s = setup.mcpServers.create({ project_id: p1.id, name: 'gh', type: 'stdio', command: 'npx', args: [] });
    // Try to patch it via p2's route
    const res = await setup.app.inject({
      method: 'PATCH',
      url: `/api/projects/${p2.id}/mcp-servers/${s.id}`,
      body: { args: ['hacked'] },
    });
    expect(res.statusCode).toBe(404);
  });
});
