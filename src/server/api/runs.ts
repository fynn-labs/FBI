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
import { validateModelParams } from './modelParams.js';
import type {
  HistoryOp, HistoryResult, MergeStrategy,
  ChildRunSummary,
  FilesDirtyEntry, FileDiffPayload,
} from '../../shared/types.js';
import type { ChangesPayload, ChangeCommit } from '../../shared/types.js';
import type { ParsedOpResult } from '../orchestrator/historyOp.js';
import { parseUnifiedDiff } from '../diffParse.js';
import { SafeguardRepo } from '../orchestrator/safeguardRepo.js';

interface GhDeps {
  available(): Promise<boolean>;
  prForBranch(repo: string, branch: string): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string } | null>;
  prChecks(repo: string, branch: string): Promise<Check[]>;
  createPr(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string }>;
  compareFiles(repo: string, base: string, head: string): Promise<Array<{ filename: string; additions: number; deletions: number; status: string }>>;
  compareBranch(repo: string, baseBranch: string, branch: string): Promise<{
    commits: Array<{ sha: string; subject: string; committed_at: number; pushed: boolean }>;
    aheadBy: number;
    behindBy: number;
    mergeBaseSha: string;
  }>;
}

interface OrchestratorDep {
  writeStdin(runId: number, bytes: Uint8Array): void;
  execInContainer(runId: number, cmd: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  execHistoryOp(runId: number, op: HistoryOp): Promise<ParsedOpResult>;
  spawnSubRun(parentRunId: number, kind: 'merge-conflict' | 'polish', argsJson: string): Promise<number>;
  deleteRun(runId: number): void;
  initSafeguard(runId: number): void;
}

interface WipRepoDep {
  exists(runId: number): boolean;
  snapshotSha(runId: number): string | null;
  parentSha(runId: number): string | null;
  readSnapshotFiles(runId: number): FilesDirtyEntry[];
  readSnapshotDiff(runId: number, filePath: string): FileDiffPayload;
  readSnapshotPatch(runId: number): string;
  deleteWipRef(runId: number): void;
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
  wipRepo: WipRepoDep;
}

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


function parseNumstat(raw: string): import('../../shared/types.js').FilesHeadEntry[] {
  const out: import('../../shared/types.js').FilesHeadEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [a, d, p] = line.split('\t');
    if (!p) continue;
    const adds = a === '-' ? 0 : Number.parseInt(a, 10) || 0;
    const dels = d === '-' ? 0 : Number.parseInt(d, 10) || 0;
    const status: 'A' | 'M' | 'D' =
      adds === 0 && dels > 0 ? 'D' :
      dels === 0 && adds > 0 ? 'A' : 'M';
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
    const commit = line.match(/^ {2}> ([0-9a-f]+) (.+)$/);
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
    const body = req.body as {
      prompt: string;
      branch?: string;
      draft_token?: string;
      model?: string | null;
      effort?: string | null;
      subagent_model?: string | null;
    };
    const hint = (body.branch ?? '').trim();
    const token = typeof body.draft_token === 'string' ? body.draft_token : '';
    if (token.length > 0 && !isDraftToken(token)) {
      return reply.code(400).send({ error: 'invalid_token' });
    }
    const verdict = validateModelParams({
      model: body.model,
      effort: body.effort,
      subagent_model: body.subagent_model,
    });
    if (!verdict.ok) {
      return reply.code(400).send({ error: verdict.message });
    }
    const projectId = Number(id);
    const force = (body as { force?: unknown }).force === true;
    if (hint !== '' && !force) {
      const active = deps.runs.listActiveByBranch(projectId, hint);
      if (active.length > 0) {
        return reply.code(409).send({
          error: 'branch_in_use',
          active_run_id: active[0].id,
          message: `Run #${active[0].id} is already using branch "${hint}". Pass { force: true } to start another run on the same branch anyway.`,
        });
      }
    }
    const run = deps.runs.create({
      project_id: projectId,
      prompt: body.prompt,
      branch_hint: hint === '' ? undefined : hint,
      log_path_tmpl: (rid) => path.join(deps.runsDir, `${rid}.log`),
      model: body.model ?? null,
      effort: body.effort ?? null,
      subagent_model: body.subagent_model ?? null,
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
        // Rollback: delete the run row and any uploads dir. initSafeguard has not run yet, so no wip.git exists.
        deps.runs.delete(run.id);
        try {
          fs.rmSync(path.join(deps.runsDir, String(run.id)), { recursive: true, force: true });
        } catch { /* noop */ }
        app.log.error({ err }, 'draft promotion failed');
        return reply.code(422).send({ error: 'promotion_failed' });
      }
    }
    // Normalize branch_name: the user's typed branch is primary. When they
    // don't type one, we default to claude/run-N so there's still a valid
    // target for the agent and the UI. supervisor.sh also creates a mirror
    // claude/run-N copy alongside the primary.
    const effectiveBranch = hint !== '' ? hint : `claude/run-${run.id}`;
    if (run.branch_name !== effectiveBranch) {
      deps.runs.setBranchName(run.id, effectiveBranch);
      run.branch_name = effectiveBranch;
    }
    // Provision the safeguard bare repo now that draft promotion has succeeded.
    // Cheap, and lets the /safeguard bind mount start synchronously when the
    // container launches. If launch itself fails later, the delete-run codepath
    // cleans up via wipRepo.remove (called from deleteRun in orchestrator/index.ts).
    deps.orchestrator.initSafeguard(run.id);
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
    const body = (req.body ?? {}) as {
      model?: string | null;
      effort?: string | null;
      subagent_model?: string | null;
    };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    const verdict = checkContinueEligibility(run, deps.runsDir);
    if (!verdict.ok) {
      return reply.code(409).send({ code: verdict.code, message: verdict.message });
    }
    const valid = validateModelParams({
      model: body.model,
      effort: body.effort,
      subagent_model: body.subagent_model,
    });
    if (!valid.ok) {
      return reply.code(400).send({ error: valid.message });
    }
    // Continue is "the dialog is source of truth": always overwrite. The UI
    // pre-fills the dialog from the current run so unchanged fields round-trip.
    deps.runs.updateModelParams(run.id, {
      model: body.model ?? null,
      effort: body.effort ?? null,
      subagent_model: body.subagent_model ?? null,
    });
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
    const total = LogStore.byteSize(run.log_path);
    reply.header('X-Transcript-Total', String(total));
    reply.header('content-type', 'text/plain; charset=utf-8');

    if (total === 0) {
      return reply.send(Buffer.alloc(0));
    }

    const rangeHeader = req.headers.range;
    const m = typeof rangeHeader === 'string'
      ? /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim())
      : null;
    if (!m) {
      const bytes = LogStore.readAll(run.log_path);
      return reply.send(Buffer.from(bytes));
    }

    const start = Number(m[1]);
    const end = m[2] === '' ? total - 1 : Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      return reply.code(416)
        .header('content-range', `bytes */${total}`)
        .send();
    }
    const clampedEnd = Math.min(end, total - 1);
    const bytes = LogStore.readRange(run.log_path, start, clampedEnd);
    return reply.code(206)
      .header('content-range', `bytes ${start}-${clampedEnd}/${total}`)
      .send(Buffer.from(bytes));
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

    const commits: ChangeCommit[] = [];
    let ghPayload: ChangesPayload['integrations']['github'] | undefined;
    let branchBase: ChangesPayload['branch_base'] = null;

    const safeguard = new SafeguardRepo(path.join(deps.runsDir, String(runId), 'wip.git'));

    if (repo && ghAvail && run.branch_name && project) {
      const [pr, checks, ghCompare] = await Promise.all([
        deps.gh.prForBranch(repo, run.branch_name).catch(() => null),
        deps.gh.prChecks(repo, run.branch_name).catch(() => [] as Check[]),
        deps.gh.compareBranch(repo, project.default_branch, run.branch_name)
          .catch(() => ({ commits: [], aheadBy: 0, behindBy: 0, mergeBaseSha: '' })),
      ]);
      const ghShas = new Set(ghCompare.commits.map((c) => c.sha));
      for (const c of ghCompare.commits) {
        commits.push({
          sha: c.sha, subject: c.subject, committed_at: c.committed_at,
          pushed: true, files: [], files_loaded: false, submodule_bumps: [],
        });
      }
      // Safeguard commits not yet pushed to GitHub. Use merge base to exclude
      // pre-run history that was already on the base branch. The safeguard
      // always stores commits under claude/run-N (the fixed mirror ref), so
      // fall back to that name when the primary branch has been renamed.
      const mirrorBranch = `claude/run-${runId}`;
      const safeguardBranch = safeguard.refExists(run.branch_name)
        ? run.branch_name
        : mirrorBranch;
      const safeguardCommits = safeguard.listCommits(safeguardBranch, ghCompare.mergeBaseSha);
      for (const c of safeguardCommits) {
        if (!ghShas.has(c.sha)) commits.push(c);
      }
      branchBase = {
        base: project.default_branch,
        ahead: ghCompare.aheadBy,
        behind: ghCompare.behindBy,
      };
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
    } else {
      const mirrorBranch = `claude/run-${runId}`;
      const safeguardBranch = run.branch_name && safeguard.refExists(run.branch_name)
        ? run.branch_name
        : (safeguard.refExists(mirrorBranch) ? mirrorBranch : null);
      const safeguardCommits = safeguardBranch ? safeguard.listCommits(safeguardBranch, '') : [];
      for (const c of safeguardCommits) commits.push(c);
    }

    // Submodule bumps: under the safeguard model this data is not surfaced
    // in the real-time path (container may be gone; reading from safeguard
    // would require submodule objects we don't store there). Ship with
    // empty arrays.
    for (const c of commits) c.submodule_bumps = [];

    const children: ChildRunSummary[] = deps.runs.listByParent(runId).map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      created_at: r.created_at,
    }));

    const payload: ChangesPayload = {
      branch_name: run.branch_name || null,
      branch_base: branchBase,
      commits,
      uncommitted: [],  // scope A — no uncommitted
      integrations: ghPayload ? { github: ghPayload } : {},
      dirty_submodules: [],
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
    } catch (e) {
      return { kind: 'git-unavailable', message: e instanceof Error ? e.message : String(e) } satisfies HistoryResult;
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

  app.get('/api/runs/:id/wip', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!deps.wipRepo.exists(id)) return { ok: false, reason: 'no-wip' };
    const snapshotSha = deps.wipRepo.snapshotSha(id);
    if (!snapshotSha) return { ok: false, reason: 'no-wip' };
    const files = deps.wipRepo.readSnapshotFiles(id);
    if (files.length === 0) return { ok: false, reason: 'no-wip' };
    const parentSha = deps.wipRepo.parentSha(id) ?? '';
    return { ok: true, snapshot_sha: snapshotSha, parent_sha: parentSha, files };
  });

  app.get('/api/runs/:id/wip/file', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const filePath = (req.query as { path?: string }).path ?? '';
    if (!filePath) return { hunks: [], truncated: false, path: filePath, ref: 'wip' };
    return deps.wipRepo.readSnapshotDiff(id, filePath);
  });

  app.post('/api/runs/:id/wip/discard', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!deps.wipRepo.exists(id)) return reply.code(404).send({ ok: false });
    deps.wipRepo.deleteWipRef(id);
    return { ok: true };
  });

  app.get('/api/runs/:id/wip/patch', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!deps.wipRepo.exists(id)) return reply.code(404).send('');
    const patch = deps.wipRepo.readSnapshotPatch(id);
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="run-${id}-wip.patch"`);
    return patch;
  });

}
