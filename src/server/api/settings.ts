import type { FastifyInstance } from 'fastify';
import type { SettingsRepo } from '../db/settings.js';

interface Deps {
  settings: SettingsRepo;
  runGc: () => Promise<{ deletedCount: number; deletedBytes: number }>;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/settings', async () => deps.settings.get());

  app.patch('/api/settings', async (req) => {
    const body = req.body as {
      global_prompt?: string;
      notifications_enabled?: boolean;
      concurrency_warn_at?: number;
      image_gc_enabled?: boolean;
      global_marketplaces?: string[];
      global_plugins?: string[];
    };
    return deps.settings.update(body);
  });

  app.post('/api/settings/run-gc', async () => {
    return await deps.runGc();
  });
}
