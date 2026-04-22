import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { legacyDefaultLists } from '../config.js';

interface Deps {
  config: Config;
}

export function registerConfigRoutes(app: FastifyInstance, _deps: Deps): void {
  app.get('/api/config/defaults', async () => {
    const lists = legacyDefaultLists();
    return {
      defaultMarketplaces: lists.marketplaces,
      defaultPlugins: lists.plugins,
    };
  });
}
