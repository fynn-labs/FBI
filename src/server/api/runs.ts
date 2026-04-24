import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { RunsRepo } from '../db/runs.js';
import type { Check } from '../github/gh.js';
import type { ProjectsRepo } from '../db/projects.js';
import { parseGitHubRepo } from '../../shared/parseGitHubRepo.js';
import { LogStore } from '../logs/store.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { checkContinueEligibility } from '../orchestrator/continueEligibility.js';
import { promoteDraft } from '../uploads/promote.js';
import { isDraftToken } from '../uploads/token.js';
import type {
  FilesPayload, FilesHeadEntry, FileDiffPayload, FileDiffHunk,
  GithubPayload, MergeResponse,
} from '../../shared/types.js';

interface GhDeps {
  available(): Promise<boolean>;
  prForBranch(repo: string, branch: string): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string } | null>;
  prChecks(repo: string, branch: string): Promise<Check[]>;
  createPr(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string }>;
  compareFiles(repo: string, base: string, head: string): Promise<Array<{ filename: string; additions: number; deletions: number; status: string }>>;
  commitsOnBranch(repo: string, branch: string): Promise<Array<{ sha: string; subject: string; committed_at: number; pushed: boolean }>>;
  mergeBranch(repo: string, head: string, base: string, commit_message: string): Promise<
    { merged: true; sha: string } | { merged: false; reason: 'conflict' | 'gh-error' | 'already-merged' }
  >;
}

interface OrchestratorDep {
  writeStdin(runId: number, bytes: Uint8Array): void;
  getLastFiles(runId: number): FilesPayload | null;
  execInContainer(runId: number, cmd: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

interface Deps {
  runs: RunsRepo;
  projects: ProjectsRepo;
  gh: GhDeps;
  streams: RunStreamRegistry;
  runsDir: string;
  draftUploadsDir: string;
  launch: (runId: number) => Promise<void>;
  cancel: (runId: number) => Promise<void>;
  fireResumeNow: (runId: number) => void;
  continueRun: (runId: number) => Promise<void>;
  markStartingForContinueRequest: (runId: number) => void;  // NEW
  orchestrator: OrchestratorDep;
}

const GH_STATUS_TTL_MS = 10_000;
interface GhStatusCache { value: GithubPayload; expiresAt: number }
const ghStatusCache = new Map<number, GhStatusCache>();
function getCached(runId: number): GithubPayload | null {
  const e = ghStatusCache.get(runId);
  if (!e || Date.now() > e.expiresAt) return null;
  return e.value;
}
function setCached(runId: number, value: GithubPayload): void {
  ghStatusCache.set(runId, { value, expiresAt: Date.now() + GH_STATUS_TTL_MS });
}
function invalidate(runId: number): void { ghStatusCache.delete(runId); }

function parseUnifiedDiff(raw: string, path: string, ref: string): FileDiffPayload {
  const MAX = 256 * 1024;
  const truncated = raw.length > MAX;
  const body = truncated ? raw.slice(0, MAX) : raw;
  const hunks: FileDiffHunk[] = [];
  let current: FileDiffHunk | null = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.lines.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-') && !line.startsWith('---')) current.lines.push({ kind: 'del', text: line.slice(1) });
    else if (line.startsWith(' ')) current.lines.push({ kind: 'ctx', text: line.slice(1) });
  }
  return { path, ref: ref === 'worktree' ? 'worktree' : ref, hunks, truncated };
}

export function registerRunsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/runs', async (req) => {
    const q = req.query as {
      state?: string; project_id?: string; q?: string; limit?: string; offset?: string;
    };
    const paged = q.limit !== undefined || q.offset !== undefined;
    const state = (q.state === 'running' || q.state === 'queued' ||
      q.state === 'succeeded' || q.state === 'failed' || q.state === 'cancelled' ||
      q.state === 'awaiting_resume')
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
    const body = req.body as { prompt: string; branch?: string; draft_token?: string };
    const hint = (body.branch ?? '').trim();
    const token = typeof body.draft_token === 'string' ? body.draft_token : '';
    if (token.length > 0 && !isDraftToken(token)) {
      return reply.code(400).send({ error: 'invalid_token' });
    }
    const run = deps.runs.create({
      project_id: Number(id),
      prompt: body.prompt,
      branch_hint: hint === '' ? undefined : hint,
      log_path_tmpl: (rid) => path.join(deps.runsDir, `${rid}.log`),
    });
    if (token.length > 0) {
      try {
        await promoteDraft({
          draftDir: deps.draftUploadsDir,
          runsDir: deps.runsDir,
          token,
          runId: run.id,
        });
      } catch (err) {
        // Rollback: delete the run row and its (possibly partial) uploads dir.
        deps.runs.delete(run.id);
        try {
          fs.rmSync(path.join(deps.runsDir, String(run.id)), { recursive: true, force: true });
        } catch { /* noop */ }
        app.log.error({ err }, 'draft promotion failed');
        return reply.code(422).send({ error: 'promotion_failed' });
      }
    }
    void deps.launch(run.id).catch((err) => app.log.error({ err }, 'launch failed'));
    reply.code(201);
    return run;
  });

  app.delete('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.state === 'running' || run.state === 'awaiting_resume') {
      await deps.cancel(run.id);
    } else {
      deps.runs.delete(run.id);
      try { fs.unlinkSync(run.log_path); } catch { /* noop */ }
    }
    return reply.code(204).send();
  });

  app.patch('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { title?: unknown };
    const raw = typeof body?.title === 'string' ? body.title : '';
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 120) {
      return reply.code(400).send({ error: 'invalid title' });
    }
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });
    deps.runs.updateTitle(runId, trimmed, { lock: true, respectLock: false });
    const after = deps.runs.get(runId)!;
    deps.streams.getOrCreateEvents(runId).publish({
      type: 'title',
      title: after.title,
      title_locked: after.title_locked,
    });
    return after;
  });

  app.post('/api/runs/:id/resume-now', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.state !== 'awaiting_resume') return reply.code(409).send({ error: 'not awaiting resume' });
    deps.fireResumeNow(run.id);
    return reply.code(204).send();
  });

  app.post('/api/runs/:id/continue', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    // Synchronous eligibility check so 409s don't pay the latency of the
    // orchestrator's full container-start sequence.
    const verdict = checkContinueEligibility(run, deps.runsDir);
    if (!verdict.ok) {
      return reply.code(409).send({ code: verdict.code, message: verdict.message });
    }
    // Flip to 'starting' synchronously so the UI's WS state message lands
    // within milliseconds of the click — before Docker is even called.
    // continueEligibility's source-state check rejects 'starting', so a
    // double-click is a clean 409.
    deps.markStartingForContinueRequest(run.id);
    // Fire-and-forget: continueRun runs the entire container lifecycle, so
    // awaiting it would block the HTTP response for the duration of the run.
    void deps.continueRun(run.id).catch((err) => {
      app.log.error({ err }, 'continueRun failed');
    });
    return reply.code(204).send();
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
      const payload: GithubPayload = {
        pr: null, checks: null, commits: [], github_available: available && !!repo,
      };
      setCached(runId, payload);
      return payload;
    }

    const pr = await deps.gh.prForBranch(repo, run.branch_name).catch(() => null);
    const checks = await deps.gh.prChecks(repo, run.branch_name).catch(() => [] as Check[]);
    const commits = await deps.gh.commitsOnBranch(repo, run.branch_name).catch(() => []);
    const passed = checks.filter((c) => c.conclusion === 'success').length;
    const failed = checks.filter((c) => c.conclusion === 'failure').length;
    const total = checks.length;
    const state = total === 0 ? null :
      (failed > 0 ? 'failure' :
       checks.every((c) => c.status === 'completed') ? 'success' : 'pending');

    const payload: GithubPayload = {
      pr: pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null,
      checks: total === 0 || state === null ? null : {
        state, passed, failed, total,
        items: checks.map((c) => ({
          name: c.name, status: c.status, conclusion: c.conclusion, duration_ms: null,
        })),
      },
      commits,
      github_available: true,
    };
    setCached(runId, payload);
    return payload;
  });

  app.get('/api/runs/:id/files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });

    const live = deps.orchestrator.getLastFiles(runId);
    if (live) return live;

    const project = deps.projects.get(run.project_id);
    const repo = project ? parseGitHubRepo(project.repo_url) : null;
    const available = await deps.gh.available();
    if (!project || !repo || !run.branch_name || !available) {
      return {
        dirty: [], head: null, headFiles: [], branchBase: null, live: false,
      } satisfies FilesPayload;
    }
    const files = await deps.gh.compareFiles(repo, project.default_branch, run.branch_name).catch(() => []);
    const headFiles: FilesHeadEntry[] = files.map((f) => {
      const status = f.status === 'added' ? 'A'
        : f.status === 'removed' ? 'D'
        : f.status === 'renamed' ? 'R'
        : 'M';
      return { path: f.filename, status, additions: f.additions, deletions: f.deletions };
    });
    return {
      dirty: [],
      head: null,
      headFiles,
      branchBase: { base: project.default_branch, ahead: headFiles.length > 0 ? 1 : 0, behind: 0 },
      live: false,
    } satisfies FilesPayload;
  });

  app.get('/api/runs/:id/file-diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const q = req.query as { path?: string; ref?: string };
    if (!q.path) return reply.code(400).send({ error: 'path required' });
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });
    const safePath = q.path.replace(/[^\w./@+-]/g, '');
    if (safePath !== q.path) return reply.code(400).send({ error: 'invalid path' });
    const ref = q.ref && q.ref !== 'worktree' ? q.ref : 'worktree';
    const safeRef = ref === 'worktree' ? 'worktree' : ref.replace(/[^\w./@+-]/g, '');
    if (safeRef !== ref) return reply.code(400).send({ error: 'invalid ref' });
    const cmd = ref === 'worktree'
      ? ['git', '-C', '/workspace', 'diff', '--', safePath]
      : ['git', '-C', '/workspace', 'show', safeRef, '--', safePath];
    try {
      const r = await deps.orchestrator.execInContainer(runId, cmd, { timeoutMs: 5000 });
      return parseUnifiedDiff(r.stdout, safePath, ref);
    } catch (e) {
      return reply.code(409).send({ error: 'no container', message: (e as Error).message });
    }
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
    if (!run.branch_name) {
      return reply.code(400).send({ error: 'run has no branch to open a PR from' });
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

  app.post('/api/runs/:id/github/merge', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });
    const project = deps.projects.get(run.project_id);
    const repo = project ? parseGitHubRepo(project.repo_url) : null;
    if (!project || !repo) {
      return reply.code(400).send({ merged: false, reason: 'not-github' } satisfies MergeResponse);
    }
    if (!run.branch_name) {
      return reply.code(400).send({ merged: false, reason: 'no-branch' } satisfies MergeResponse);
    }
    if (!(await deps.gh.available())) {
      return reply.code(503).send({ merged: false, reason: 'gh-not-available' } satisfies MergeResponse);
    }

    const commitMsg = `Merge branch '${run.branch_name}' (FBI run #${runId})`;
    const r = await deps.gh.mergeBranch(repo, run.branch_name, project.default_branch, commitMsg);
    if (r.merged) {
      invalidate(runId);
      return { merged: true, sha: r.sha } satisfies MergeResponse;
    }
    if (r.reason === 'already-merged') {
      invalidate(runId);
      return { merged: false, reason: 'already-merged' } satisfies MergeResponse;
    }
    if (r.reason !== 'conflict') {
      return reply.code(500).send({ merged: false, reason: 'gh-error' } satisfies MergeResponse);
    }

    // Conflict. If the run's container is alive, inject a merge prompt via
    // stdin so Claude resolves it. Otherwise the user needs a live container.
    if (run.state !== 'running' && run.state !== 'waiting') {
      return reply.code(409).send({ merged: false, reason: 'agent-busy' } satisfies MergeResponse);
    }
    const prompt =
      `Merge branch ${run.branch_name} into ${project.default_branch}, ` +
      `resolve conflicts, and push ${project.default_branch}. Steps:\n` +
      `1. git fetch origin\n` +
      `2. git checkout ${project.default_branch}\n` +
      `3. git pull --ff-only origin ${project.default_branch}\n` +
      `4. git merge --no-ff ${run.branch_name}\n` +
      `5. If conflicts: resolve, git add, git commit.\n` +
      `6. git push origin ${project.default_branch}\n`;
    try {
      deps.orchestrator.writeStdin(runId, Buffer.from(prompt + '\n'));
      return { merged: false, reason: 'conflict', agent: true } satisfies MergeResponse;
    } catch {
      return reply.code(409).send({ merged: false, reason: 'agent-busy' } satisfies MergeResponse);
    }
  });
}
