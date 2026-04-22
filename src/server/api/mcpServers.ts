import type { FastifyInstance } from 'fastify';
import type { McpServersRepo, CreateMcpServerInput } from '../db/mcpServers.js';

type CreateBody = Omit<CreateMcpServerInput, 'project_id'>;

interface Deps {
  mcpServers: McpServersRepo;
}

export function registerMcpServerRoutes(
  app: FastifyInstance,
  deps: Deps
): void {
  // Global MCP servers
  app.get('/api/mcp-servers', async () => deps.mcpServers.listGlobal());

  app.post('/api/mcp-servers', async (req, reply) => {
    const body = req.body as CreateBody;
    const created = deps.mcpServers.create({ project_id: null, ...body });
    reply.code(201);
    return created;
  });

  app.patch('/api/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const updated = deps.mcpServers.update(Number(id), req.body as Parameters<McpServersRepo['update']>[1]);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  });

  app.delete('/api/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = deps.mcpServers.get(Number(id));
    if (!existing) return reply.code(404).send({ error: 'not found' });
    deps.mcpServers.delete(Number(id));
    reply.code(204);
  });

  // Per-project MCP servers
  app.get('/api/projects/:id/mcp-servers', async (req) => {
    const { id } = req.params as { id: string };
    return deps.mcpServers.listForProject(Number(id));
  });

  app.post('/api/projects/:id/mcp-servers', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as CreateBody;
    const created = deps.mcpServers.create({ project_id: Number(id), ...body });
    reply.code(201);
    return created;
  });

  app.patch('/api/projects/:id/mcp-servers/:sid', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string };
    const existing = deps.mcpServers.get(Number(sid));
    if (!existing || existing.project_id !== Number(id)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const updated = deps.mcpServers.update(Number(sid), req.body as Parameters<McpServersRepo['update']>[1]);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  });

  app.delete('/api/projects/:id/mcp-servers/:sid', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string };
    const existing = deps.mcpServers.get(Number(sid));
    if (!existing || existing.project_id !== Number(id)) {
      return reply.code(404).send({ error: 'not found' });
    }
    deps.mcpServers.delete(Number(sid));
    reply.code(204);
  });
}
