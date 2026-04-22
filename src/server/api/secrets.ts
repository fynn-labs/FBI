import type { FastifyInstance } from 'fastify';
import type { SecretsRepo } from '../db/secrets.js';

interface Deps {
  secrets: SecretsRepo;
}

export function registerSecretsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/projects/:id/secrets', async (req) => {
    const { id } = req.params as { id: string };
    return deps.secrets.list(Number(id));
  });

  app.put('/api/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const { value } = req.body as { value: string };
    deps.secrets.upsert(Number(id), name, value);
    reply.code(204);
  });

  app.delete('/api/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    deps.secrets.remove(Number(id), name);
    reply.code(204);
  });
}
