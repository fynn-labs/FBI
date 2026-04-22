import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { McpServersRepo } from './mcpServers.js';
import { ProjectsRepo } from './projects.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  return openDb(path.join(dir, 'db.sqlite'));
}

describe('McpServersRepo', () => {
  let repo: McpServersRepo;
  let projectId: number;

  beforeEach(() => {
    const db = tmpDb();
    repo = new McpServersRepo(db);
    const projects = new ProjectsRepo(db);
    const p = projects.create({
      name: 'test', repo_url: 'git@github.com:x/y.git', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    projectId = p.id;
  });

  it('creates and lists a global server', () => {
    const s = repo.create({ project_id: null, name: 'puppeteer', type: 'stdio', command: 'npx', args: ['-y', '@mcp/puppeteer'] });
    expect(s.id).toBeGreaterThan(0);
    expect(s.name).toBe('puppeteer');
    expect(repo.listGlobal()).toHaveLength(1);
  });

  it('creates and lists a per-project server', () => {
    repo.create({ project_id: projectId, name: 'github', type: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: '$GH' } });
    expect(repo.listForProject(projectId)).toHaveLength(1);
    expect(repo.listGlobal()).toHaveLength(0);
  });

  it('listEffective merges global and project, project wins on name collision', () => {
    repo.create({ project_id: null, name: 'fetch', type: 'stdio', command: 'npx', args: ['a'] });
    repo.create({ project_id: null, name: 'shared', type: 'stdio', command: 'npx', args: ['global'] });
    repo.create({ project_id: projectId, name: 'shared', type: 'stdio', command: 'npx', args: ['project'] });
    const effective = repo.listEffective(projectId);
    expect(effective).toHaveLength(2);
    const shared = effective.find((s) => s.name === 'shared')!;
    expect(shared.args).toEqual(['project']);
  });

  it('updates a server', () => {
    const s = repo.create({ project_id: null, name: 'mem', type: 'stdio', command: 'npx', args: [] });
    const updated = repo.update(s.id, { args: ['-y', 'new'] });
    expect(updated?.args).toEqual(['-y', 'new']);
  });

  it('deletes a server', () => {
    const s = repo.create({ project_id: null, name: 'del', type: 'stdio', command: 'npx', args: [] });
    repo.delete(s.id);
    expect(repo.listGlobal()).toHaveLength(0);
  });

  it('cascades delete when project is deleted', () => {
    repo.create({ project_id: projectId, name: 'github', type: 'stdio', command: 'npx', args: [] });
    const db = (repo as any).db;
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    expect(repo.listForProject(projectId)).toHaveLength(0);
  });

  it('returns undefined for non-existent id in get()', () => {
    expect(repo.get(9999)).toBeUndefined();
  });

  it('returns null for non-existent id in update()', () => {
    expect(repo.update(9999, { args: [] })).toBeNull();
  });

  it('throws on duplicate name within same scope', () => {
    repo.create({ project_id: null, name: 'dup', type: 'stdio', command: 'npx', args: [] });
    expect(() =>
      repo.create({ project_id: null, name: 'dup', type: 'stdio', command: 'npx', args: [] })
    ).toThrow();
  });
});
