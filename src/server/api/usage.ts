import type { FastifyInstance } from 'fastify';
import type { UsageRepo } from '../db/usage.js';
import type { UsageState } from '../../shared/types.js';

interface Deps {
  usage: UsageRepo;
  pollerSnapshot: () => UsageState;
}

export function registerUsageRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/usage', async () => deps.pollerSnapshot());

  app.get('/api/usage/daily', async (req) => {
    const q = req.query as { days?: string };
    const days = Number(q.days ?? 14);
    return deps.usage.listDailyUsage({
      days: Number.isFinite(days) ? days : 14,
      now: Date.now(),
    });
  });

  app.get('/api/usage/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    if (!Number.isFinite(runId)) return reply.code(400).send({ error: 'invalid id' });
    return deps.usage.getRunBreakdown(runId);
  });
}
