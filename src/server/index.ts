import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Docker from 'dockerode';
import fs from 'node:fs';
import { loadConfig, legacyDefaultLists } from './config.js';
import { openDb } from './db/index.js';
import { ProjectsRepo } from './db/projects.js';
import { RunsRepo } from './db/runs.js';
import { SecretsRepo } from './db/secrets.js';
import { SettingsRepo } from './db/settings.js';
import { McpServersRepo } from './db/mcpServers.js';
import { RateLimitStateRepo } from './db/rateLimitState.js';
import { loadKey } from './crypto.js';
import { RunStreamRegistry } from './logs/registry.js';
import { Orchestrator } from './orchestrator/index.js';
import { registerProjectRoutes } from './api/projects.js';
import { registerSecretsRoutes } from './api/secrets.js';
import { registerRunsRoutes } from './api/runs.js';
import { registerSettingsRoutes } from './api/settings.js';
import { registerConfigRoutes } from './api/config.js';
import { registerMcpServerRoutes } from './api/mcpServers.js';
import { registerWsRoute } from './api/ws.js';
import { GhClient } from './github/gh.js';

async function main() {
  const config = loadConfig();
  fs.mkdirSync(config.runsDir, { recursive: true });

  const db = openDb(config.dbPath);
  const key = loadKey(config.secretsKeyFile);
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const secrets = new SecretsRepo(db, key);
  const settings = new SettingsRepo(db);
  const mcpServers = new McpServersRepo(db);
  const rateLimitState = new RateLimitStateRepo(db);

  // One-time migration: if FBI_DEFAULT_* env vars are set and the DB still has empty
  // global lists, migrate them in so existing deployments don't lose configuration.
  const legacy = legacyDefaultLists();
  const currentSettings = settings.get();
  const migrationPatch: { global_marketplaces?: string[]; global_plugins?: string[] } = {};
  if (legacy.marketplaces.length > 0 && currentSettings.global_marketplaces.length === 0)
    migrationPatch.global_marketplaces = legacy.marketplaces;
  if (legacy.plugins.length > 0 && currentSettings.global_plugins.length === 0)
    migrationPatch.global_plugins = legacy.plugins;
  if (Object.keys(migrationPatch).length > 0) settings.update(migrationPatch);

  const streams = new RunStreamRegistry();
  const docker = new Docker();

  const orchestrator = new Orchestrator({
    docker, config, projects, runs, secrets, settings, mcpServers, streams, rateLimitState,
  });
  const gh = new GhClient();

  const app = Fastify({ logger: true });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: config.webDir,
    prefix: '/',
  });
  app.get('/api/health', async () => ({ ok: true }));

  registerProjectRoutes(app, { projects, secrets, runs });
  registerSecretsRoutes(app, { secrets });
  registerRunsRoutes(app, {
    runs, projects, gh,
    runsDir: config.runsDir,
    launch: (id) => orchestrator.launch(id),
    cancel: (id) => orchestrator.cancel(id),
    fireResumeNow: (id) => orchestrator.fireResumeNow(id),
  });
  registerSettingsRoutes(app, {
    settings,
    runGc: () => orchestrator.runGcOnce(),
  });
  registerConfigRoutes(app, { config });
  registerMcpServerRoutes(app, { mcpServers });
  registerWsRoute(app, { runs, streams, orchestrator });

  // SPA fallback: any non-/api route returns index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });

  await orchestrator.recover();
  await orchestrator.rehydrateSchedules();
  await orchestrator.startGcScheduler();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
