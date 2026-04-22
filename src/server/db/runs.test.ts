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

  it('creates a queued run with computed fields', () => {
    const run = runs.create({
      project_id: projectId,
      prompt: 'hello',
      branch_name_tmpl: (id) => `claude/run-${id}`,
      log_path_tmpl: (id) => `/tmp/runs/${id}.log`,
    });
    expect(run.state).toBe('queued');
    expect(run.branch_name).toBe(`claude/run-${run.id}`);
    expect(run.log_path).toBe(`/tmp/runs/${run.id}.log`);
  });

  it('markStarted and markFinished update state', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      branch_name_tmpl: (id) => `b-${id}`,
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
      branch_name_tmpl: (id) => `b-${id}`,
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(r.id, 'c');
    expect(runs.listByState('running').length).toBe(1);
  });
});
