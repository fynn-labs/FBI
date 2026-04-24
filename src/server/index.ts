import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, legacyDefaultLists } from './config.js';
import { openDb } from './db/index.js';
import { ProjectsRepo } from './db/projects.js';
import { RunsRepo } from './db/runs.js';
import { SecretsRepo } from './db/secrets.js';
import { SettingsRepo } from './db/settings.js';
import { McpServersRepo } from './db/mcpServers.js';
import { RateLimitStateRepo } from './db/rateLimitState.js';
import { RateLimitBucketsRepo } from './db/rateLimitBuckets.js';
import { UsageRepo } from './db/usage.js';
import { CredentialsReader } from './credentialsReader.js';
import { OAuthUsagePoller } from './oauthUsagePoller.js';
import type { UsageWsMessage } from '../shared/types.js';
import { loadKey } from './crypto.js';
import { RunStreamRegistry } from './logs/registry.js';
import { Orchestrator } from './orchestrator/index.js';
import { registerProjectRoutes } from './api/projects.js';
import { registerSecretsRoutes } from './api/secrets.js';
import { registerRunsRoutes } from './api/runs.js';
import { registerSettingsRoutes } from './api/settings.js';
import { registerConfigRoutes } from './api/config.js';
import { registerCliRoutes } from './api/cli.js';
import { registerMcpServerRoutes } from './api/mcpServers.js';
import { registerWsRoute } from './api/ws.js';
import { registerUsageRoutes } from './api/usage.js';
import { registerUsageWsRoute } from './api/wsUsage.js';
import { registerProxyRoutes } from './api/proxy.js';
import { registerUploadsRoutes } from './api/uploads.js';
import { startDraftUploadsGc } from './housekeeping/draftUploads.js';
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
  const rateLimitBuckets = new RateLimitBucketsRepo(db);
  const usage = new UsageRepo(db);

  // Usage WebSocket bus — poller publishes snapshots + threshold_crossed here.
  const usageSubs = new Set<(m: UsageWsMessage) => void>();
  const onUsageEvent = (m: UsageWsMessage): void => { for (const cb of usageSubs) cb(m); };

  const credsReader = new CredentialsReader({
    file: path.join(config.hostClaudeDir, '.credentials.json'),
  });
  const poller = new OAuthUsagePoller({
    fetch,
    readToken: () => credsReader.read(),
    state: rateLimitState,
    buckets: rateLimitBuckets,
    onEvent: onUsageEvent,
  });
  credsReader.onChange(() => { void poller.nudge(); });

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
    docker, config, projects, runs, secrets, settings, mcpServers, streams, rateLimitState, usage,
    poller: { nudge: () => poller.nudge() },
  });
  const gh = new GhClient();

  const app = Fastify({ logger: true });
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2 },
  });
  await app.register(fastifyStatic, {
    root: config.webDir,
    prefix: '/',
  });
  app.get('/api/health', async () => ({ ok: true }));

  registerProjectRoutes(app, { projects, secrets, runs });
  registerSecretsRoutes(app, { secrets });
  registerRunsRoutes(app, {
    runs, projects, gh,
    streams,
    runsDir: config.runsDir,
    draftUploadsDir: config.draftUploadsDir,
    launch: (id) => orchestrator.launch(id),
    cancel: (id) => orchestrator.cancel(id),
    fireResumeNow: (id) => orchestrator.fireResumeNow(id),
    continueRun: (id) => orchestrator.continueRun(id),
    markStartingForContinueRequest: (id) => orchestrator.markStartingForContinueRequest(id),
    orchestrator: {
      writeStdin: (id, bytes) => orchestrator.writeStdin(id, bytes),
      getLastFiles: (id) => orchestrator.getLastFiles(id),
      execInContainer: (id, cmd, opts) => orchestrator.execInContainer(id, cmd, opts),
      execHistoryOp: (id, op) => orchestrator.execHistoryOp(id, op),
      spawnSubRun: (id, kind, argsJson) => orchestrator.spawnSubRun(id, kind, argsJson),
      deleteRun: (id) => orchestrator.deleteRun(id),
    },
    wipRepo: orchestrator.wipRepo,
  });
  registerSettingsRoutes(app, {
    settings,
    runGc: () => orchestrator.runGcOnce(),
  });
  registerConfigRoutes(app, { config });
  registerMcpServerRoutes(app, { mcpServers });
  registerWsRoute(app, { runs, streams, orchestrator });
  registerUsageRoutes(app, { usage, pollerSnapshot: () => poller.snapshot() });
  registerUsageWsRoute(app, {
    bus: {
      snapshot: () => poller.snapshot(),
      subscribe: (cb) => { usageSubs.add(cb); return () => usageSubs.delete(cb); },
    },
  });
  registerProxyRoutes(app, {
    runs, streams,
    orchestrator: { getLiveContainer: (id) => orchestrator.getLiveContainer(id) },
  });

  fs.mkdirSync(config.draftUploadsDir, { recursive: true });
  registerUploadsRoutes(app, {
    runs,
    runsDir: config.runsDir,
    draftUploadsDir: config.draftUploadsDir,
  });

  const stopDraftUploadsGc = startDraftUploadsGc({
    runsDir: config.runsDir,
    draftDir: config.draftUploadsDir,
  });

  registerCliRoutes(app, {
    cliDistDir: config.cliDistDir,
    version: process.env.FBI_VERSION,
  });

  // Startup log: is the fbi-tunnel dist dir populated?
  try {
    const entries = fs.readdirSync(config.cliDistDir).filter((f) => f.startsWith('fbi-tunnel-'));
    if (entries.length >= 4) app.log.info({ dir: config.cliDistDir, count: entries.length }, 'fbi-tunnel binaries present');
    else app.log.warn({ dir: config.cliDistDir, count: entries.length }, 'fbi-tunnel binaries missing — /api/cli/fbi-tunnel/* will 503');
  } catch {
    app.log.warn({ dir: config.cliDistDir }, 'fbi-tunnel binaries missing — /api/cli/fbi-tunnel/* will 503');
  }

  // SPA fallback: any non-/api route returns index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });

  await orchestrator.recover();
  await orchestrator.rehydrateSchedules();
  await orchestrator.startGcScheduler();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  poller.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
