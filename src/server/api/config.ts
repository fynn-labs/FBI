import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

interface Deps {
  config: Config;
}

export function registerConfigRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/config/defaults', async () => ({
    defaultMarketplaces: deps.config.defaultMarketplaces,
    defaultPlugins: deps.config.defaultPlugins,
  }));
}
