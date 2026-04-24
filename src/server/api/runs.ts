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
  FilesPayload, FilesHeadEntry,
  GithubPayload, HistoryOp, HistoryResult, MergeStrategy,
  ChildRunSummary, SubmoduleBump, SubmoduleDirty,
} from '../../shared/types.js';
import type { ChangesPayload, ChangeCommit } from '../../shared/types.js';
import type { ParsedOpResult } from '../orchestrator/historyOp.js';
import { parseUnifiedDiff } from '../diffParse.js';

interface GhDeps {
  available(): Promise<boolean>;
  prForBranch(repo: string, branch: string): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string } | null>;
  prChecks(repo: string, branch: string): Promise<Check[]>;
  createPr(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string }>;
  compareFiles(repo: string, base: string, head: string): Promise<Array<{ filename: string; additions: number; deletions: number; status: string }>>;
  commitsOnBranch(repo: string, branch: string): Promise<Array<{ sha: string; subject: string; committed_at: number; pushed: boolean }>>;
}

interface OrchestratorDep {
  writeStdin(runId: number, bytes: Uint8Array): void;
  getLastFiles(runId: number): FilesPayload | null;
  execInContainer(runId: number, cmd: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  execHistoryOp(runId: number, op: HistoryOp): Promise<ParsedOpResult>;
  spawnSubRun(parentRunId: number, kind: 'merge-conflict' | 'polish', argsJson: string): Promise<number>;
  deleteRun(runId: number): void;
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

const CHANGES_TTL_MS = 10_000;
const changesCache = new Map<number, { value: ChangesPayload; expiresAt: number }>();
function getChangesCached(runId: number): ChangesPayload | null {
  const e = changesCache.get(runId);
  if (!e || Date.now() > e.expiresAt) return null;
  return e.value;
}
function setChangesCached(runId: number, value: ChangesPayload): void {
  changesCache.set(runId, { value, expiresAt: Date.now() + CHANGES_TTL_MS });
}
function invalidateChanges(runId: number): void { changesCache.delete(runId); }


function parseNumstat(raw: string): import('../../shared/types.js').FilesHeadEntry[] {
  const out: import('../../shared/types.js').FilesHeadEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [a, d, p] = line.split('\t');
    if (!p) continue;
    const adds = a === '-' ? 0 : Number.parseInt(a, 10) || 0;
    const dels = d === '-' ? 0 : Number.parseInt(d, 10) || 0;
    const status: 'A' | 'M' = dels === 0 && adds > 0 ? 'A' : 'M';
    out.push({ path: p, status, additions: adds, deletions: dels });
  }
  return out;
}

interface RawBump {
  path: string;
  from: string;
  to: string;
  subjects: Array<{ sha: string; subject: string }>;
}

export function parseSubmoduleLog(raw: string): RawBump[] {
  const out: RawBump[] = [];
  let current: RawBump | null = null;
  for (const line of raw.split('\n')) {
    const header = line.match(/^Submodule (\S+) ([0-9a-f]+)\.\.([0-9a-f]+):?/);
    if (header) {
      current = { path: header[1], from: header[2], to: header[3], subjects: [] };
      out.push(current);
      continue;
    }
    const commit = line.match(/^  > ([0-9a-f]+) (.+)$/);
    if (current && commit) {
      current.subjects.push({ sha: commit[1], subject: commit[2] });
    }
  }
  return out;
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
        // Rollback path: rm the just-created row/files before wipRepo.init has run
        // (init happens at the top of launch()). Therefore no wip.git exists yet
        // and the full deleteRun() orchestration isn't needed here.
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
      deps.orchestrator.deleteRun(run.id);
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

  app.get('/api/runs/:id/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });

    const cached = getChangesCached(runId);
    if (cached) return cached;

    const project = deps.projects.get(run.project_id);
    const repo = project ? parseGitHubRepo(project.repo_url) : null;
    const ghAvail = await deps.gh.available();
    const live = deps.orchestrator.getLastFiles(runId);

    const commits: ChangeCommit[] = [];
    let ghPayload: ChangesPayload['integrations']['github'] | undefined;

    if (repo && ghAvail && run.branch_name) {
      const [pr, checks, ghCommits] = await Promise.all([
        deps.gh.prForBranch(repo, run.branch_name).catch(() => null),
        deps.gh.prChecks(repo, run.branch_name).catch(() => [] as Check[]),
        deps.gh.commitsOnBranch(repo, run.branch_name).catch(() => []),
      ]);
      for (const c of ghCommits) {
        commits.push({ sha: c.sha, subject: c.subject, committed_at: c.committed_at, pushed: true, files: [], files_loaded: false, submodule_bumps: [] });
      }
      const passed = checks.filter((c) => c.conclusion === 'success').length;
      const failed = checks.filter((c) => c.conclusion === 'failure').length;
      const total = checks.length;
      const state = total === 0 ? null
        : failed > 0 ? 'failure'
        : checks.every((c) => c.status === 'completed') ? 'success'
        : 'pending';
      ghPayload = {
        pr: pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null,
        checks: total === 0 || state === null ? null : {
          state, passed, failed, total,
          items: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, duration_ms: null })),
        },
      };
    }

    // If we have a live head commit that isn't in the gh list, prepend it as pushed:false.
    if (live?.head) {
      if (!commits.some((c) => c.sha === live.head!.sha)) {
        commits.unshift({
          sha: live.head.sha,
          subject: live.head.subject,
          committed_at: Math.floor(Date.now() / 1000),
          pushed: false,
          files: live.headFiles,
          files_loaded: true,
          submodule_bumps: [],
        });
      }
    }

    // Populate submodule_bumps for each commit via git show --submodule=log.
    for (const c of commits) {
      c.submodule_bumps = [];
      try {
        const r = await deps.orchestrator.execInContainer(runId, [
          'git', '-C', '/workspace', 'show', c.sha, '--submodule=log', '--no-color',
        ], { timeoutMs: 3000 });
        if (r.exitCode === 0) {
          const raw = parseSubmoduleLog(r.stdout);
          c.submodule_bumps = raw.map((b): SubmoduleBump => ({
            path: b.path,
            url: null,
            from: b.from,
            to: b.to,
            commits: b.subjects.slice(0, 20).map((s) => ({
              sha: s.sha, subject: s.subject, committed_at: 0, pushed: false,
              files: [], files_loaded: false, submodule_bumps: [],
            })),
            commits_truncated: b.subjects.length > 20,
          }));
        }
      } catch { /* live container gone; skip bumps for this commit */ }
    }

    const dirty_submodules: SubmoduleDirty[] = live?.dirty_submodules ?? [];

    const children: ChildRunSummary[] = deps.runs.listByParent(runId).map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      created_at: r.created_at,
    }));

    const payload: ChangesPayload = {
      branch_name: run.branch_name || null,
      branch_base: live?.branchBase ?? null,
      commits,
      uncommitted: live?.dirty ?? [],
      integrations: ghPayload ? { github: ghPayload } : {},
      dirty_submodules,
      children,
    };
    setChangesCached(runId, payload);
    return payload;
  });

  app.get('/api/runs/:id/commits/:sha/files', async (req, reply) => {
    const { id, sha } = req.params as { id: string; sha: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return reply.code(400).send({ error: 'invalid sha' });

    // Prefer docker exec on a live container — works for any commit.
    try {
      const r = await deps.orchestrator.execInContainer(runId, [
        'git', '-C', '/workspace', 'show', '--numstat', '--format=', sha,
      ], { timeoutMs: 5000 });
      if (r.exitCode === 0) return { files: parseNumstat(r.stdout) };
    } catch { /* no container — fall through */ }

    // Fallback: gh api compare parent..sha.
    const project = deps.projects.get(run.project_id);
    const repo = project ? parseGitHubRepo(project.repo_url) : null;
    if (!repo || !(await deps.gh.available())) return { files: [] };
    const files = await deps.gh.compareFiles(repo, `${sha}^`, sha).catch(() => []);
    return {
      files: files.map((f) => ({
        path: f.filename,
        status: (f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M') as 'A'|'D'|'M'|'R',
        additions: f.additions, deletions: f.deletions,
      })),
    };
  });

  app.get('/api/runs/:id/submodule/*', async (req, reply) => {
    const rawPath = (req.params as { '*': string })['*'];
    // expected: <submodule-path>/commits/<sha>/files
    const m = rawPath.match(/^(.+)\/commits\/([0-9a-f]{7,40})\/files$/);
    if (!m) return reply.code(404).send({ error: 'not found' });
    const [, submodulePath, sha] = m;
    if (submodulePath.includes('..')) return reply.code(400).send({ error: 'invalid path' });

    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });

    try {
      const r = await deps.orchestrator.execInContainer(runId, [
        'git', '-C', `/workspace/${submodulePath}`, 'show', '--numstat', '--format=', sha,
      ], { timeoutMs: 5000 });
      if (r.exitCode === 0) return { files: parseNumstat(r.stdout) };
    } catch { /* no container */ }
    return { files: [] };
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

  app.post('/api/runs/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (!run.branch_name) {
      return reply.code(400).send({ kind: 'invalid', message: 'run has no branch' } satisfies HistoryResult);
    }
    const body = req.body as Partial<HistoryOp> | null;
    if (!body || typeof body !== 'object' || typeof (body as { op?: unknown }).op !== 'string') {
      return reply.code(400).send({ kind: 'invalid', message: 'op required' } satisfies HistoryResult);
    }
    const op = body as HistoryOp;

    // 'polish' is always agent-driven — no direct git path.
    if (op.op === 'polish') {
      const project = deps.projects.get(run.project_id);
      const argsJson = JSON.stringify({
        branch: run.branch_name,
        default: project?.default_branch ?? 'main',
      });
      const childId = await deps.orchestrator.spawnSubRun(runId, 'polish', argsJson);
      return { kind: 'agent', child_run_id: childId } satisfies HistoryResult;
    }

    // For merge/sync/squash-local: resolve strategy default, then dispatch.
    let resolved: HistoryOp = op;
    if (op.op === 'merge' && !op.strategy) {
      const project = deps.projects.get(run.project_id);
      resolved = { op: 'merge', strategy: project?.default_merge_strategy ?? 'squash' };
    }

    let result: ParsedOpResult;
    try {
      result = await deps.orchestrator.execHistoryOp(runId, resolved);
    } catch {
      return reply.code(503).send({ kind: 'git-unavailable' } satisfies HistoryResult);
    }

    if (result.kind === 'complete') {
      return { kind: 'complete', sha: result.sha } satisfies HistoryResult;
    }
    if (result.kind === 'conflict-detected') {
      const project = deps.projects.get(run.project_id);
      const strategy: MergeStrategy =
        resolved.op === 'merge' ? (resolved.strategy ?? 'merge') : 'merge';
      const argsJson = JSON.stringify({
        branch: run.branch_name,
        default: project?.default_branch ?? 'main',
        strategy,
      });
      const childId = await deps.orchestrator.spawnSubRun(runId, 'merge-conflict', argsJson);
      return { kind: 'conflict', child_run_id: childId } satisfies HistoryResult;
    }
    // gh-error: return 200 with the structured message so the client can
    // surface it instead of throwing on HTTP 500.
    return { kind: 'git-error', message: result.message } satisfies HistoryResult;
  });

}
