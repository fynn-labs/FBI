import type { FastifyInstance } from 'fastify';
import type { SettingsRepo } from '../db/settings.js';

interface Deps {
  settings: SettingsRepo;
  runGc: () => Promise<{ deletedCount: number; deletedBytes: number }>;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/settings', async () => deps.settings.get());

  app.patch('/api/settings', async (req, reply) => {
    const body = req.body as {
      global_prompt?: string;
      notifications_enabled?: boolean;
      concurrency_warn_at?: number;
      image_gc_enabled?: boolean;
      global_marketplaces?: string[];
      global_plugins?: string[];
      auto_resume_enabled?: boolean;
      auto_resume_max_attempts?: number;
      usage_notifications_enabled?: boolean;
    };
    if (body.auto_resume_max_attempts !== undefined) {
      const v = body.auto_resume_max_attempts;
      if (!Number.isInteger(v) || v < 1 || v > 20) {
        return reply.code(400).send({ error: 'auto_resume_max_attempts must be an integer between 1 and 20' });
      }
    }
    return deps.settings.update(body);
  });

  app.post('/api/settings/run-gc', async () => {
    return await deps.runGc();
  });
}
