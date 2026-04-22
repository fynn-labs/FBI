import { describe, it, expect } from 'vitest';
import { openDb, migrate } from './index.js';
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
      { name: 'rate_limit_buckets' },
      { name: 'rate_limit_state' },
      { name: 'run_usage_events' },
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

// --- TokenEater migration ---
describe('migrate() TokenEater schema', () => {
  it('rate_limit_buckets table exists with expected columns', () => {
    const db = openDb(':memory:');
    const cols = db.prepare("PRAGMA table_info(rate_limit_buckets)").all() as {name: string}[];
    expect(cols.map(c => c.name).sort()).toEqual([
      'bucket_id', 'last_notified_reset_at', 'last_notified_threshold',
      'observed_at', 'reset_at', 'utilization', 'window_started_at',
    ]);
  });

  it('rate_limit_state has new thinned shape on fresh DB', () => {
    const db = openDb(':memory:');
    const cols = db.prepare("PRAGMA table_info(rate_limit_state)").all() as {name: string}[];
    expect(cols.map(c => c.name).sort()).toEqual([
      'id', 'last_error', 'last_error_at', 'observed_at', 'plan',
    ]);
  });

  it('upgrade path: old rate_limit_state rebuilt, observed_at preserved', () => {
    const db = openDb(':memory:');
    db.exec(`DROP TABLE rate_limit_state;
             CREATE TABLE rate_limit_state (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               requests_remaining INTEGER, observed_at INTEGER NOT NULL);
             INSERT INTO rate_limit_state(id, requests_remaining, observed_at) VALUES (1, 99, 1234);`);
    migrate(db);
    const row = db.prepare('SELECT * FROM rate_limit_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row.observed_at).toBe(1234);
    expect('requests_remaining' in row).toBe(false);
    expect('plan' in row).toBe(true);
  });

  it('tokens_total recomputed once (input + output); sentinel prevents re-run', () => {
    const db = openDb(':memory:');
    const now = Date.now();
    db.prepare(`INSERT INTO projects (id, name, repo_url, default_branch, created_at, updated_at)
                VALUES (1, 'p', 'git://x', 'main', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO runs (id, project_id, prompt, branch_name, state, log_path, created_at,
                  tokens_input, tokens_output, tokens_cache_read, tokens_cache_create, tokens_total)
                VALUES (1, 1, 'p', 'b', 'succeeded', '/l', ?, 100, 200, 1000, 500, 999999)`).run(now);
    // Clear the sentinel set by openDb's migrate() so we can trigger recompute.
    db.prepare('UPDATE settings SET tokens_total_recomputed_at = NULL WHERE id = 1').run();
    migrate(db);
    const run = db.prepare('SELECT tokens_total FROM runs WHERE id = 1').get() as {tokens_total:number};
    expect(run.tokens_total).toBe(300);
    const t1 = (db.prepare('SELECT tokens_total_recomputed_at FROM settings WHERE id = 1').get() as {tokens_total_recomputed_at:number|null}).tokens_total_recomputed_at;
    expect(t1).not.toBeNull();
    // Re-run must be a no-op.
    db.prepare('UPDATE runs SET tokens_total = 0 WHERE id = 1').run();
    migrate(db);
    const run2 = db.prepare('SELECT tokens_total FROM runs WHERE id = 1').get() as {tokens_total:number};
    expect(run2.tokens_total).toBe(0);
    const t2 = (db.prepare('SELECT tokens_total_recomputed_at FROM settings WHERE id = 1').get() as {tokens_total_recomputed_at:number|null}).tokens_total_recomputed_at;
    expect(t2).toBe(t1);
  });

  it('settings.usage_notifications_enabled column exists, defaults 0', () => {
    const db = openDb(':memory:');
    const cols = db.prepare("PRAGMA table_info(settings)").all() as {name:string; dflt_value:string|null}[];
    const col = cols.find(c => c.name === 'usage_notifications_enabled');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('0');
  });
});
