import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  './schema.sql'
);

export type DB = Database.Database;

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>)
      .map((r) => r.name)
  );
  if (!cols.has('marketplaces_json')) {
    db.exec("ALTER TABLE projects ADD COLUMN marketplaces_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!cols.has('plugins_json')) {
    db.exec("ALTER TABLE projects ADD COLUMN plugins_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!cols.has('mem_mb')) {
    db.exec('ALTER TABLE projects ADD COLUMN mem_mb INTEGER');
  }
  if (!cols.has('cpus')) {
    db.exec('ALTER TABLE projects ADD COLUMN cpus REAL');
  }
  if (!cols.has('pids_limit')) {
    db.exec('ALTER TABLE projects ADD COLUMN pids_limit INTEGER');
  }
  const settingsCols = new Set(
    (db.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>)
      .map((r) => r.name)
  );
  if (!settingsCols.has('notifications_enabled')) {
    db.exec(
      'ALTER TABLE settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1'
    );
  }
  if (!settingsCols.has('concurrency_warn_at')) {
    db.exec('ALTER TABLE settings ADD COLUMN concurrency_warn_at INTEGER NOT NULL DEFAULT 3');
  }
  if (!settingsCols.has('image_gc_enabled')) {
    db.exec('ALTER TABLE settings ADD COLUMN image_gc_enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!settingsCols.has('last_gc_at')) {
    db.exec('ALTER TABLE settings ADD COLUMN last_gc_at INTEGER');
  }
  if (!settingsCols.has('last_gc_count')) {
    db.exec('ALTER TABLE settings ADD COLUMN last_gc_count INTEGER');
  }
  if (!settingsCols.has('last_gc_bytes')) {
    db.exec('ALTER TABLE settings ADD COLUMN last_gc_bytes INTEGER');
  }
  if (!settingsCols.has('global_marketplaces_json')) {
    db.exec("ALTER TABLE settings ADD COLUMN global_marketplaces_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!settingsCols.has('global_plugins_json')) {
    db.exec("ALTER TABLE settings ADD COLUMN global_plugins_json TEXT NOT NULL DEFAULT '[]'");
  }
  const runCols = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>)
      .map((r) => r.name)
  );
  if (!runCols.has('resume_attempts')) {
    db.exec('ALTER TABLE runs ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!runCols.has('next_resume_at')) {
    db.exec('ALTER TABLE runs ADD COLUMN next_resume_at INTEGER');
  }
  if (!runCols.has('claude_session_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN claude_session_id TEXT');
  }
  if (!runCols.has('last_limit_reset_at')) {
    db.exec('ALTER TABLE runs ADD COLUMN last_limit_reset_at INTEGER');
  }
  if (!settingsCols.has('auto_resume_enabled')) {
    db.exec('ALTER TABLE settings ADD COLUMN auto_resume_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!settingsCols.has('auto_resume_max_attempts')) {
    db.exec('ALTER TABLE settings ADD COLUMN auto_resume_max_attempts INTEGER NOT NULL DEFAULT 5');
  }
  for (const c of [
    'tokens_input', 'tokens_output', 'tokens_cache_read',
    'tokens_cache_create', 'tokens_total', 'usage_parse_errors',
  ]) {
    if (!runCols.has(c)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    }
  }
  if (!runCols.has('title')) {
    db.exec('ALTER TABLE runs ADD COLUMN title TEXT');
  }
  if (!runCols.has('title_locked')) {
    db.exec('ALTER TABLE runs ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0');
  }

  // --- TokenEater usage migration ---

  // 1. Rebuild rate_limit_state if it still has the old per-bucket columns.
  const rlsCols = new Set(
    (db.prepare("PRAGMA table_info(rate_limit_state)").all() as Array<{ name: string }>)
      .map(r => r.name)
  );
  if (rlsCols.has('requests_remaining')) {
    db.exec(`BEGIN;
      CREATE TABLE rate_limit_state_new (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        plan TEXT,
        observed_at INTEGER,
        last_error TEXT,
        last_error_at INTEGER
      );
      INSERT INTO rate_limit_state_new (id, observed_at)
        SELECT id, observed_at FROM rate_limit_state;
      DROP TABLE rate_limit_state;
      ALTER TABLE rate_limit_state_new RENAME TO rate_limit_state;
      COMMIT;`);
  }

  // 2. Make sure the thinned state table exists (fresh DB + post-rebuild).
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limit_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    plan TEXT,
    observed_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER
  )`);

  // 3. Buckets table.
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_id TEXT PRIMARY KEY,
    utilization REAL NOT NULL,
    reset_at INTEGER,
    window_started_at INTEGER,
    last_notified_threshold INTEGER,
    last_notified_reset_at INTEGER,
    observed_at INTEGER NOT NULL
  )`);

  // 4. New settings columns.
  const settingsCols2 = new Set(
    (db.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>)
      .map(r => r.name)
  );
  if (!settingsCols2.has('usage_notifications_enabled')) {
    db.exec('ALTER TABLE settings ADD COLUMN usage_notifications_enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!settingsCols2.has('tokens_total_recomputed_at')) {
    db.exec('ALTER TABLE settings ADD COLUMN tokens_total_recomputed_at INTEGER');
  }

  // 5. Seed settings row (MUST happen before the recompute reads the sentinel).
  db.prepare(
    "INSERT OR IGNORE INTO settings (id, global_prompt, notifications_enabled, concurrency_warn_at, image_gc_enabled, updated_at) VALUES (1, '', 1, 3, 0, ?)"
  ).run(Date.now());

  // 6. One-shot recompute: tokens_total = input + output.
  const sentinel = db.prepare('SELECT tokens_total_recomputed_at FROM settings WHERE id = 1').get() as { tokens_total_recomputed_at: number | null } | undefined;
  if (!sentinel?.tokens_total_recomputed_at) {
    db.exec('UPDATE runs SET tokens_total = tokens_input + tokens_output');
    db.prepare('UPDATE settings SET tokens_total_recomputed_at = ? WHERE id = 1').run(Date.now());
  }
}
