import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';
import { RunsRepo } from './runs.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  return openDb(path.join(dir, 'db.sqlite'));
}

describe('ProjectsRepo', () => {
  let repo: ProjectsRepo;
  beforeEach(() => {
    repo = new ProjectsRepo(tmpDb());
  });

  it('creates and retrieves a project', () => {
    const p = repo.create({
      name: 'foo',
      repo_url: 'git@github.com:me/foo.git',
      default_branch: 'main',
      devcontainer_override_json: null,
      instructions: null,
      git_author_name: null,
      git_author_email: null,
    });
    expect(p.id).toBeGreaterThan(0);
    expect(repo.get(p.id)?.name).toBe('foo');
  });

  it('enforces unique name', () => {
    repo.create({
      name: 'dup', repo_url: 'a', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    expect(() =>
      repo.create({
        name: 'dup', repo_url: 'b', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null,
      })
    ).toThrow();
  });

  it('updates a project', () => {
    const p = repo.create({
      name: 'bar', repo_url: 'x', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    repo.update(p.id, { instructions: 'be careful' });
    expect(repo.get(p.id)?.instructions).toBe('be careful');
  });

  it('lists and deletes', () => {
    repo.create({
      name: 'a', repo_url: 'a', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const p = repo.create({
      name: 'b', repo_url: 'b', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    expect(repo.list().length).toBe(2);
    repo.delete(p.id);
    expect(repo.list().length).toBe(1);
  });

  it('stores and reads resource caps', () => {
    const p = repo.create({
      name: 'capped',
      repo_url: 'u',
      default_branch: 'main',
      devcontainer_override_json: null,
      instructions: null,
      git_author_name: null,
      git_author_email: null,
      mem_mb: 2048,
      cpus: 1.5,
      pids_limit: 256,
    });
    expect(p.mem_mb).toBe(2048);
    expect(p.cpus).toBe(1.5);
    expect(p.pids_limit).toBe(256);

    repo.update(p.id, { mem_mb: null, cpus: null, pids_limit: null });
    const cleared = repo.get(p.id)!;
    expect(cleared.mem_mb).toBeNull();
    expect(cleared.cpus).toBeNull();
    expect(cleared.pids_limit).toBeNull();
  });

  it('defaults resource caps to null when omitted', () => {
    const p = repo.create({
      name: 'defaulted',
      repo_url: 'u',
      default_branch: 'main',
      devcontainer_override_json: null,
      instructions: null,
      git_author_name: null,
      git_author_email: null,
    });
    expect(p.mem_mb).toBeNull();
    expect(p.cpus).toBeNull();
    expect(p.pids_limit).toBeNull();
  });

  it('list() attaches last_run when runs exist', () => {
    const p = repo.create({
      name: 'withruns', repo_url: 'u', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const runs = new RunsRepo((repo as unknown as { db: ReturnType<typeof openDb> }).db);
    const r = runs.create({ project_id: p.id, prompt: 'x',
      log_path_tmpl: (id: number) => `/tmp/${id}.log` });
    const listed = repo.list().find((x) => x.id === p.id)!;
    expect(listed.last_run).toBeTruthy();
    expect(listed.last_run!.id).toBe(r.id);
  });

  it('list() returns last_run null when no runs', () => {
    const p = repo.create({
      name: 'empty', repo_url: 'u', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const listed = repo.list().find((x) => x.id === p.id)!;
    expect(listed.last_run).toBeNull();
  });
});
