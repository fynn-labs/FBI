import type { FastifyInstance } from 'fastify';
import type { ProjectsRepo } from '../db/projects.js';
import type { SecretsRepo } from '../db/secrets.js';

interface Deps {
  projects: ProjectsRepo;
  secrets: SecretsRepo;
}

export function registerProjectRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/projects', async () => deps.projects.list());

  app.post('/api/projects', async (req, reply) => {
    const body = req.body as {
      name: string;
      repo_url: string;
      default_branch?: string;
      devcontainer_override_json?: string | null;
      instructions?: string | null;
      git_author_name?: string | null;
      git_author_email?: string | null;
      marketplaces?: string[];
      plugins?: string[];
      mem_mb?: number | null;
      cpus?: number | null;
      pids_limit?: number | null;
    };
    const created = deps.projects.create({
      name: body.name,
      repo_url: body.repo_url,
      default_branch: body.default_branch ?? 'main',
      devcontainer_override_json: body.devcontainer_override_json ?? null,
      instructions: body.instructions ?? null,
      git_author_name: body.git_author_name ?? null,
      git_author_email: body.git_author_email ?? null,
      marketplaces: body.marketplaces ?? [],
      plugins: body.plugins ?? [],
      mem_mb: body.mem_mb ?? null,
      cpus: body.cpus ?? null,
      pids_limit: body.pids_limit ?? null,
    });
    reply.code(201);
    return created;
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = deps.projects.get(Number(id));
    if (!p) return reply.code(404).send({ error: 'not found' });
    return p;
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.projects.update(Number(id), req.body as Record<string, unknown>);
    const p = deps.projects.get(Number(id));
    if (!p) return reply.code(404).send({ error: 'not found' });
    return p;
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.projects.delete(Number(id));
    reply.code(204);
  });
}
