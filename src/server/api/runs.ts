import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { RunsRepo } from '../db/runs.js';
import { LogStore } from '../logs/store.js';

interface Deps {
  runs: RunsRepo;
  runsDir: string;
  launch: (runId: number) => Promise<void>;
  cancel: (runId: number) => Promise<void>;
}

export function registerRunsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/runs', async (req) => {
    const state = (req.query as { state?: string }).state;
    if (state === 'running' || state === 'queued' || state === 'succeeded' || state === 'failed' || state === 'cancelled') {
      return deps.runs.listByState(state);
    }
    return deps.runs.listAll();
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    return run;
  });

  app.get('/api/projects/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    return deps.runs.listByProject(Number(id));
  });

  app.post('/api/projects/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { prompt } = req.body as { prompt: string };
    const run = deps.runs.create({
      project_id: Number(id),
      prompt,
      branch_name_tmpl: (rid) => `claude/run-${rid}`,
      log_path_tmpl: (rid) => path.join(deps.runsDir, `${rid}.log`),
    });
    void deps.launch(run.id).catch((err) => app.log.error({ err }, 'launch failed'));
    reply.code(201);
    return run;
  });

  app.delete('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.state === 'running') {
      await deps.cancel(run.id);
    } else {
      deps.runs.delete(run.id);
      try { fs.unlinkSync(run.log_path); } catch { /* noop */ }
    }
    reply.code(204);
  });

  app.get('/api/runs/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    const bytes = LogStore.readAll(run.log_path);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return Buffer.from(bytes);
  });
}
