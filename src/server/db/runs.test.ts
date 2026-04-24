import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';
import { RunsRepo } from './runs.js';

function makeRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'a', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  return { runs, projectId: p.id };
}

describe('RunsRepo', () => {
  let runs: RunsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepos();
    runs = r.runs;
    projectId = r.projectId;
  });

  it('creates a queued run with empty branch when no hint given', () => {
    const run = runs.create({
      project_id: projectId,
      prompt: 'hello',
      log_path_tmpl: (id) => `/tmp/runs/${id}.log`,
    });
    expect(run.state).toBe('queued');
    expect(run.branch_name).toBe('');
    expect(run.log_path).toBe(`/tmp/runs/${run.id}.log`);
  });

  it('stores a branch hint on create', () => {
    const run = runs.create({
      project_id: projectId,
      prompt: 'hi',
      branch_hint: 'fix-login-bug',
      log_path_tmpl: (id) => `/tmp/runs/${id}.log`,
    });
    expect(run.branch_name).toBe('fix-login-bug');
  });

  it('markStarted and markFinished update state', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'container-abc');
    expect(runs.get(run.id)!.state).toBe('running');
    expect(runs.get(run.id)!.container_id).toBe('container-abc');

    runs.markFinished(run.id, {
      state: 'succeeded',
      exit_code: 0,
      head_commit: 'deadbeef',
    });
    const after = runs.get(run.id)!;
    expect(after.state).toBe('succeeded');
    expect(after.head_commit).toBe('deadbeef');
    expect(after.container_id).toBeNull();
    expect(after.finished_at).not.toBeNull();
  });

  it('lists running runs', () => {
    const r = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(r.id, 'c');
    expect(runs.listByState('running').length).toBe(1);
  });

  it('listRecentPrompts returns distinct prompts newest-first with limit', () => {
    const mk = (prompt: string) =>
      runs.create({
        project_id: projectId,
        prompt,
        log_path_tmpl: (id) => `/tmp/${id}.log`,
      });
    mk('alpha');
    mk('beta');
    mk('alpha');
    mk('gamma');

    const recent = runs.listRecentPrompts(projectId, 10);
    expect(recent.map((r) => r.prompt)).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('markFinished can overwrite branch_name', () => {
    const run = runs.create({
      project_id: projectId,
      prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c');
    runs.markFinished(run.id, {
      state: 'succeeded',
      exit_code: 0,
      head_commit: 'deadbeef',
      branch_name: 'fix-login-bug',
    });
    expect(runs.get(run.id)!.branch_name).toBe('fix-login-bug');
  });

  it('listFiltered filters by state', () => {
    const a = runs.create({ project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.create({ project_id: projectId, prompt: 'y',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.markStarted(a.id, 'c');
    runs.markFinished(a.id, { state: 'succeeded', exit_code: 0, head_commit: 'h' });

    const res = runs.listFiltered({ state: 'succeeded', limit: 50, offset: 0 });
    expect(res.total).toBe(1);
    expect(res.items.map((r) => r.id)).toEqual([a.id]);
  });

  it('listFiltered supports pagination', () => {
    for (let i = 0; i < 5; i++) {
      runs.create({ project_id: projectId, prompt: `p${i}`,
        log_path_tmpl: (id) => `/tmp/${id}.log` });
    }
    const page1 = runs.listFiltered({ limit: 2, offset: 0 });
    const page2 = runs.listFiltered({ limit: 2, offset: 2 });
    expect(page1.total).toBe(5);
    expect(page1.items.length).toBe(2);
    expect(page2.items.length).toBe(2);
    expect(page1.items[0].id).not.toBe(page2.items[0].id);
  });

  it('listFiltered supports prompt search (case-insensitive)', () => {
    runs.create({ project_id: projectId, prompt: 'FIX LOGIN bug',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.create({ project_id: projectId, prompt: 'unrelated',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const res = runs.listFiltered({ q: 'fix login', limit: 50, offset: 0 });
    expect(res.total).toBe(1);
    expect(res.items[0].prompt).toBe('FIX LOGIN bug');
  });

  it('listFiltered scopes by project_id', () => {
    const otherProj = new ProjectsRepo((runs as any).db)
      .create({ name: 'p2', repo_url: 'b', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null });
    runs.create({ project_id: projectId, prompt: 'a',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.create({ project_id: otherProj.id, prompt: 'b',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const res = runs.listFiltered({ project_id: projectId, limit: 50, offset: 0 });
    expect(res.total).toBe(1);
  });

  it('listSiblings returns other runs with the same prompt in the same project', () => {
    const a = runs.create({ project_id: projectId, prompt: 'X',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const b = runs.create({ project_id: projectId, prompt: 'X',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.create({ project_id: projectId, prompt: 'different',
      log_path_tmpl: (id) => `/tmp/${id}.log` });

    const siblings = runs.listSiblings(a.id, 10);
    expect(siblings.map((r) => r.id)).toEqual([b.id]);
  });
});

describe('RunsRepo auto-resume', () => {
  let runs: RunsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepos();
    runs = r.runs;
    projectId = r.projectId;
  });

  it('new runs have zeroed auto-resume fields', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    expect(run.resume_attempts).toBe(0);
    expect(run.next_resume_at).toBeNull();
    expect(run.claude_session_id).toBeNull();
    expect(run.last_limit_reset_at).toBeNull();
  });

  it('markAwaitingResume sets state and timestamps and bumps attempts', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c');
    runs.markAwaitingResume(run.id, { next_resume_at: 9000, last_limit_reset_at: 9000 });
    const after = runs.get(run.id)!;
    expect(after.state).toBe('awaiting_resume');
    expect(after.next_resume_at).toBe(9000);
    expect(after.last_limit_reset_at).toBe(9000);
    expect(after.resume_attempts).toBe(1);
    expect(after.container_id).toBeNull();
  });

  it('markResuming clears awaiting fields and returns to running', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    runs.markAwaitingResume(run.id, { next_resume_at: 9000, last_limit_reset_at: 9000 });
    runs.markResuming(run.id, 'c2');
    const after = runs.get(run.id)!;
    expect(after.state).toBe('running');
    expect(after.container_id).toBe('c2');
    expect(after.next_resume_at).toBeNull();
  });

  it('setClaudeSessionId writes once; no-op on subsequent calls with different value', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.setClaudeSessionId(run.id, 'session-1');
    runs.setClaudeSessionId(run.id, 'session-2'); // ignored
    expect(runs.get(run.id)!.claude_session_id).toBe('session-1');
  });

  it('listByState includes awaiting_resume rows', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c');
    runs.markAwaitingResume(run.id, { next_resume_at: 9000, last_limit_reset_at: 9000 });
    expect(runs.listByState('awaiting_resume').length).toBe(1);
  });

  it('listAwaiting returns projected id and next_resume_at for parked runs', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c');
    runs.markAwaitingResume(run.id, { next_resume_at: 9000, last_limit_reset_at: 9000 });
    const awaiting = runs.listAwaiting();
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toEqual({ id: run.id, next_resume_at: 9000 });
  });

  it('markContinuing transitions failed → running, resets resume_attempts, clears finished state', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    runs.markAwaitingResume(run.id, { next_resume_at: 1, last_limit_reset_at: 1 });
    runs.markResuming(run.id, 'c2');
    runs.markFinished(run.id, { state: 'failed', error: 'boom', exit_code: 1 });

    const before = runs.get(run.id)!;
    expect(before.state).toBe('failed');
    expect(before.resume_attempts).toBe(1);
    expect(before.error).toBe('boom');
    expect(before.finished_at).not.toBeNull();

    runs.markContinuing(run.id, 'c3');

    const after = runs.get(run.id)!;
    expect(after.state).toBe('running');
    expect(after.container_id).toBe('c3');
    expect(after.resume_attempts).toBe(0);
    expect(after.error).toBeNull();
    expect(after.exit_code).toBeNull();
    expect(after.finished_at).toBeNull();
  });

  it('markContinuing also accepts cancelled as the source state', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    runs.markFinished(run.id, { state: 'cancelled' });
    runs.markContinuing(run.id, 'c2');
    expect(runs.get(run.id)!.state).toBe('running');
  });

  it('markContinuing also accepts succeeded as the source state', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    runs.markFinished(run.id, { state: 'succeeded' });
    runs.markContinuing(run.id, 'c2');
    expect(runs.get(run.id)!.state).toBe('running');
  });

  it('markContinuing refuses to transition from non-terminal states', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    // Running → markContinuing must be a no-op.
    runs.markContinuing(run.id, 'c2');
    const after = runs.get(run.id)!;
    expect(after.container_id).toBe('c1');
    expect(after.state).toBe('running');
  });
});

describe('updateTitle', () => {
  function setup() {
    const { runs, projectId } = makeRepos();
    const run = runs.create({
      project_id: projectId,
      prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    return { runs, run };
  }

  it('sets title when row is unlocked (respectLock=true)', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, '  Fix auth race  ', { respectLock: true });
    const after = runs.get(run.id)!;
    expect((after as any).title).toBe('Fix auth race');
    expect((after as any).title_locked).toBe(0);
  });
  it('is a no-op when locked and respectLock=true', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, 'Original', { lock: true, respectLock: false });
    runs.updateTitle(run.id, 'Should not overwrite', { respectLock: true });
    expect((runs.get(run.id) as any).title).toBe('Original');
    expect((runs.get(run.id) as any).title_locked).toBe(1);
  });
  it('overwrites when respectLock=false and sets lock when lock=true', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, 'First', { respectLock: true });
    runs.updateTitle(run.id, 'User pick', { lock: true, respectLock: false });
    expect((runs.get(run.id) as any).title).toBe('User pick');
    expect((runs.get(run.id) as any).title_locked).toBe(1);
  });
  it('truncates titles longer than 80 chars', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, 'x'.repeat(200), { respectLock: true });
    expect((runs.get(run.id) as any).title).toHaveLength(80);
  });
  it('ignores empty-after-trim input', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, '   ', { respectLock: true });
    expect((runs.get(run.id) as any).title).toBeNull();
  });
});

describe('RunsRepo.state_entered_at', () => {
  let runs: RunsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepos();
    runs = r.runs;
    projectId = r.projectId;
  });

  it('sets state_entered_at on create (queued)', () => {
    const before = Date.now();
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    expect(run.state_entered_at).toBeGreaterThanOrEqual(before);
    expect(run.state_entered_at).toBeLessThanOrEqual(Date.now());
  });

  it('advances state_entered_at on each transition', async () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    const t0 = runs.get(run.id)!.state_entered_at;

    await new Promise((r) => setTimeout(r, 2));
    runs.markStarted(run.id, 'c1');
    const t1 = runs.get(run.id)!.state_entered_at;
    expect(t1).toBeGreaterThan(t0);

    await new Promise((r) => setTimeout(r, 2));
    runs.markWaiting(run.id);
    const t2 = runs.get(run.id)!.state_entered_at;
    expect(t2).toBeGreaterThan(t1);

    await new Promise((r) => setTimeout(r, 2));
    runs.markRunningFromWaiting(run.id);
    const t3 = runs.get(run.id)!.state_entered_at;
    expect(t3).toBeGreaterThan(t2);

    await new Promise((r) => setTimeout(r, 2));
    runs.markFinished(run.id, { state: 'succeeded', exit_code: 0 });
    const t4 = runs.get(run.id)!.state_entered_at;
    expect(t4).toBeGreaterThan(t3);
    expect(t4).toBe(runs.get(run.id)!.finished_at);
  });

  it('sets state_entered_at on markAwaitingResume and markResuming', async () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    const tRunning = runs.get(run.id)!.state_entered_at;

    await new Promise((r) => setTimeout(r, 2));
    runs.markAwaitingResume(run.id, { next_resume_at: Date.now() + 1000, last_limit_reset_at: null });
    const tAwaiting = runs.get(run.id)!.state_entered_at;
    expect(tAwaiting).toBeGreaterThan(tRunning);

    await new Promise((r) => setTimeout(r, 2));
    runs.markResuming(run.id, 'c2');
    const tResumed = runs.get(run.id)!.state_entered_at;
    expect(tResumed).toBeGreaterThan(tAwaiting);
  });
});

describe('base_branch and mirror_status', () => {
  let runs: RunsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepos();
    runs = r.runs;
    projectId = r.projectId;
  });

  it('setBranchName updates branch_name', () => {
    const r = runs.create({
      project_id: projectId,
      prompt: 'x',
      branch_hint: 'feat/x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.setBranchName(r.id, 'claude/run-99');
    expect(runs.get(r.id)!.branch_name).toBe('claude/run-99');
  });

  it('persists base_branch and mirror_status', () => {
    const r = runs.create({
      project_id: projectId,
      prompt: 'x',
      branch_hint: 'claude/run-1',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    expect(runs.get(r.id)!.base_branch).toBeNull();
    expect(runs.get(r.id)!.mirror_status).toBeNull();

    runs.setBaseBranch(r.id, 'feat/x');
    runs.setMirrorStatus(r.id, 'diverged');

    const fresh = runs.get(r.id)!;
    expect(fresh.base_branch).toBe('feat/x');
    expect(fresh.mirror_status).toBe('diverged');
  });
});

describe('waiting-state transitions', () => {
  function seedRunning() {
    const { runs: repo, projectId } = makeRepos();
    const run = repo.create({
      project_id: projectId,
      prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    repo.markStarted(run.id, 'c');
    return { repo, id: run.id };
  }

  function seedQueued() {
    const { runs: repo, projectId } = makeRepos();
    const run = repo.create({
      project_id: projectId,
      prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    return { repo, id: run.id };
  }

  it('markWaiting flips running → waiting', () => {
    const { repo, id } = seedRunning();
    repo.markWaiting(id);
    expect(repo.get(id)!.state).toBe('waiting');
  });

  it('markWaiting is a no-op from non-running states', () => {
    const { repo, id } = seedQueued();
    repo.markWaiting(id);
    expect(repo.get(id)!.state).toBe('queued');
  });

  it('markRunningFromWaiting flips waiting → running', () => {
    const { repo, id } = seedRunning();
    repo.markWaiting(id);
    repo.markRunningFromWaiting(id);
    expect(repo.get(id)!.state).toBe('running');
  });

  it('markRunningFromWaiting is a no-op from non-waiting states', () => {
    const { repo, id } = seedRunning();
    repo.markRunningFromWaiting(id);
    expect(repo.get(id)!.state).toBe('running');
  });

  it('markAwaitingResume wins from waiting (rate-limit supersedes)', () => {
    const { repo, id } = seedRunning();
    repo.markWaiting(id);
    repo.markAwaitingResume(id, { next_resume_at: 42, last_limit_reset_at: 42 });
    expect(repo.get(id)!.state).toBe('awaiting_resume');
  });

  it('markWaiting + markRunningFromWaiting are idempotent', () => {
    const { repo, id } = seedRunning();
    repo.markWaiting(id);
    repo.markWaiting(id);
    expect(repo.get(id)!.state).toBe('waiting');
    repo.markRunningFromWaiting(id);
    repo.markRunningFromWaiting(id);
    expect(repo.get(id)!.state).toBe('running');
  });
});
