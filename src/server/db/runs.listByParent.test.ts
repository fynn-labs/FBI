import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';
import { RunsRepo } from './runs.js';

describe('RunsRepo.listByParent', () => {
  it('returns children in id order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const parent = runs.create({ project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const child1 = runs.create({ project_id: p.id, prompt: 'c1',
      parent_run_id: parent.id, kind: 'polish',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const child2 = runs.create({ project_id: p.id, prompt: 'c2',
      parent_run_id: parent.id, kind: 'merge-conflict',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const kids = runs.listByParent(parent.id);
    expect(kids.map((r) => r.id)).toEqual([child1.id, child2.id]);
  });

  it('returns [] when no children', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const parent = runs.create({ project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    expect(runs.listByParent(parent.id)).toEqual([]);
  });
});
