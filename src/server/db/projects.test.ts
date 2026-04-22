import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';

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
});
