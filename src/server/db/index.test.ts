import { describe, it, expect } from 'vitest';
import { openDb } from './index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('openDb', () => {
  it('creates schema idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'db.sqlite');
    const db1 = openDb(p);
    const db2 = openDb(p); // second open should also succeed
    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    expect(tables).toEqual([
      { name: 'mcp_servers' },
      { name: 'project_secrets' },
      { name: 'projects' },
      { name: 'rate_limit_state' },
      { name: 'runs' },
      { name: 'settings' },
    ]);
    db1.close();
    db2.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('enforces foreign key cascades', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'db.sqlite');
    const db = openDb(p);
    db.prepare(
      `INSERT INTO projects (name, repo_url, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('x', 'git@example.com:x', 'main', 1, 1);
    const pid = (db.prepare('SELECT id FROM projects').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pid, 'hello', 'claude/run-1', 'queued', '/tmp/x.log', 1);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    const count = (db.prepare('SELECT count(*) as c FROM runs').get() as {
      c: number;
    }).c;
    expect(count).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});
