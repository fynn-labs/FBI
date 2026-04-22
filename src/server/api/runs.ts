import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { RunsRepo } from '../db/runs.js';
import type { Check } from '../github/gh.js';
import type { ProjectsRepo } from '../db/projects.js';
import { parseGitHubRepo } from '../../shared/parseGitHubRepo.js';
import { LogStore } from '../logs/store.js';

interface GhDeps {
  available(): Promise<boolean>;
  prForBranch(repo: string, branch: string): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string } | null>;
  prChecks(repo: string, branch: string): Promise<Check[]>;
  createPr(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string }>;
  compareFiles(repo: string, base: string, head: string): Promise<Array<{ filename: string; additions: number; deletions: number; status: string }>>;
}

interface Deps {
  runs: RunsRepo;
  projects: ProjectsRepo;
  gh: GhDeps;
  runsDir: string;
  launch: (runId: number) => Promise<void>;
  cancel: (runId: number) => Promise<void>;
}

const GH_STATUS_TTL_MS = 10_000;
interface GhStatusCache { value: unknown; expiresAt: number }
const ghStatusCache = new Map<number, GhStatusCache>();
function getCached(runId: number): unknown | null {
  const e = ghStatusCache.get(runId);
  if (!e || Date.now() > e.expiresAt) return null;
  return e.value;
}
function setCached(runId: number, value: unknown): void {
  ghStatusCache.set(runId, { value, expiresAt: Date.now() + GH_STATUS_TTL_MS });
}
function invalidate(runId: number): void { ghStatusCache.delete(runId); }

const DIFF_TTL_MS = 60_000;
const diffCache = new Map<number, { value: unknown; expiresAt: number }>();
function getDiffCached(runId: number): unknown | null {
  const e = diffCache.get(runId);
  if (!e || Date.now() > e.expiresAt) return null;
  return e.value;
}
function setDiffCached(runId: number, value: unknown): void {
  diffCache.set(runId, { value, expiresAt: Date.now() + DIFF_TTL_MS });
}

export function registerRunsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/runs', async (req) => {
    const q = req.query as {
      state?: string; project_id?: string; q?: string; limit?: string; offset?: string;
    };
    const paged = q.limit !== undefined || q.offset !== undefined;
    const state = (q.state === 'running' || q.state === 'queued' ||
      q.state === 'succeeded' || q.state === 'failed' || q.state === 'cancelled')
      ? q.state : undefined;

    if (!paged) {
      if (state) return deps.runs.listByState(state);
      return deps.runs.listAll();
    }

    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const offset = Math.max(0, Number(q.offset ?? 0));
    const project_id = q.project_id ? Number(q.project_id) : undefined;
    return deps.runs.listFiltered({ state, project_id, q: q.q, limit, offset });
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
    const body = req.body as { prompt: string; branch?: string };
    const hint = (body.branch ?? '').trim();
    const run = deps.runs.create({
      project_id: Number(id),
      prompt: body.prompt,
      branch_hint: hint === '' ? undefined : hint,
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

  app.get('/api/runs/:id/github', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });

    const cached = getCached(runId);
    if (cached) return cached;

    const project = deps.projects.get(run.project_id);
    const repo = project ? parseGitHubRepo(project.repo_url) : null;
    const available = await deps.gh.available();
    if (!available || !repo || !run.branch_name) {
      const payload = { pr: null, checks: null, github_available: available && !!repo };
      setCached(runId, payload);
      return payload;
    }

    const pr = await deps.gh.prForBranch(repo, run.branch_name).catch(() => null);
    const checks = await deps.gh.prChecks(repo, run.branch_name).catch(() => [] as Check[]);
    const passed = checks.filter((c) => c.conclusion === 'success').length;
    const failed = checks.filter((c) => c.conclusion === 'failure').length;
    const total = checks.length;
    const state = total === 0 ? null :
      (failed > 0 ? 'failure' :
       checks.every((c) => c.status === 'completed') ? 'success' : 'pending');

    const payload = {
      pr: pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null,
      checks: total === 0 ? null : { state, passed, failed, total },
      github_available: true,
    };
    setCached(runId, payload);
    return payload;
  });

  app.get('/api/runs/:id/diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });

    const cached = getDiffCached(runId);
    if (cached) return cached;

    const project = deps.projects.get(run.project_id);
    const repo = project ? parseGitHubRepo(project.repo_url) : null;
    const available = await deps.gh.available();
    if (!project || !repo || !run.branch_name || !available) {
      const payload = {
        base: project?.default_branch ?? '',
        head: run.branch_name,
        files: [],
        github_available: available && !!repo,
      };
      setDiffCached(runId, payload);
      return payload;
    }

    const files = await deps.gh
      .compareFiles(repo, project.default_branch, run.branch_name)
      .catch(() => []);
    const payload = {
      base: project.default_branch,
      head: run.branch_name,
      files,
      github_available: true,
    };
    setDiffCached(runId, payload);
    return payload;
  });

  app.get('/api/runs/:id/siblings', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });
    return deps.runs.listSiblings(runId, 10);
  });

  app.post('/api/runs/:id/github/pr', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.state !== 'succeeded' || !run.branch_name) {
      return reply.code(400).send({ error: 'run not eligible for PR' });
    }
    const project = deps.projects.get(run.project_id);
    const repo = project ? parseGitHubRepo(project.repo_url) : null;
    if (!project || !repo) return reply.code(400).send({ error: 'not a github project' });
    if (!(await deps.gh.available())) return reply.code(503).send({ error: 'gh-not-available' });
    const existing = await deps.gh.prForBranch(repo, run.branch_name).catch(() => null);
    if (existing) return reply.code(409).send({ error: 'PR already exists', pr: existing });

    const title = (run.prompt.split('\n')[0] ?? 'FBI run').slice(0, 72);
    const body = `${run.prompt}\n\n---\n🤖 Generated with FBI run #${runId}`;
    const pr = await deps.gh.createPr(repo, {
      head: run.branch_name, base: project.default_branch, title, body,
    });
    invalidate(runId);
    return pr;
  });
}
