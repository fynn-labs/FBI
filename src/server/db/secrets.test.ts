import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';
import { SecretsRepo } from './secrets.js';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const key = crypto.randomBytes(32);
  const projects = new ProjectsRepo(db);
  const secrets = new SecretsRepo(db, key);
  const p = projects.create({
    name: 'p', repo_url: 'a', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  return { secrets, projectId: p.id };
}

describe('SecretsRepo', () => {
  let secrets: SecretsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepo();
    secrets = r.secrets;
    projectId = r.projectId;
  });

  it('stores encrypted value and returns plaintext via decryptAll', () => {
    secrets.upsert(projectId, 'DB_URL', 'postgres://x');
    const decrypted = secrets.decryptAll(projectId);
    expect(decrypted).toEqual({ DB_URL: 'postgres://x' });
  });

  it('list returns names without values', () => {
    secrets.upsert(projectId, 'A', '1');
    secrets.upsert(projectId, 'B', '2');
    const names = secrets.list(projectId).map((s) => s.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('upsert replaces existing value', () => {
    secrets.upsert(projectId, 'K', 'v1');
    secrets.upsert(projectId, 'K', 'v2');
    expect(secrets.decryptAll(projectId)).toEqual({ K: 'v2' });
  });

  it('remove deletes', () => {
    secrets.upsert(projectId, 'K', 'v');
    secrets.remove(projectId, 'K');
    expect(secrets.decryptAll(projectId)).toEqual({});
  });
});
