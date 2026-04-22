import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { RunsRepo } from '../db/runs.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { parseProcNetTcp } from '../proxy/procListeners.js';

export interface ProxyOrchestrator {
  getLiveContainer(runId: number): {
    inspect: () => Promise<{
      State: { Pid: number };
      NetworkSettings: { IPAddress: string; Networks?: Record<string, { IPAddress: string }> };
    }>;
  } | null;
}

export interface ProxyDeps {
  runs: RunsRepo;
  streams: RunStreamRegistry;
  orchestrator: ProxyOrchestrator;
  /** Override for tests; defaults to fs.readFileSync('/proc/<pid>/net/tcp'). */
  procReader?: (pid: number) => string;
}

const defaultProcReader = (pid: number): string =>
  fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8');

export function registerProxyRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  const procReader = deps.procReader ?? defaultProcReader;

  app.get('/api/runs/:id/listening-ports', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    if (!Number.isFinite(runId)) return reply.code(400).send({ error: 'invalid run id' });
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const container = deps.orchestrator.getLiveContainer(runId);
    if (!container) return reply.code(409).send({ error: `run ${runId} is not running` });
    const inspect = await container.inspect();
    const pid = inspect.State.Pid;
    if (!pid) return reply.code(409).send({ error: 'container has no pid' });
    let text: string;
    try { text = procReader(pid); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `read /proc failed: ${msg}` });
    }
    return reply.send({ ports: parseProcNetTcp(text) });
  });
}
