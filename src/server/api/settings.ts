import type { FastifyInstance } from 'fastify';
import type { SettingsRepo } from '../db/settings.js';

interface Deps {
  settings: SettingsRepo;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/settings', async () => deps.settings.get());

  app.patch('/api/settings', async (req) => {
    const body = req.body as {
      global_prompt?: string;
      notifications_enabled?: boolean;
    };
    return deps.settings.update({
      global_prompt: body.global_prompt,
      notifications_enabled: body.notifications_enabled,
    });
  });
}
