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

function migrate(db: DB): void {
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
  if (!settingsCols.has('global_marketplaces_json')) {
    db.exec("ALTER TABLE settings ADD COLUMN global_marketplaces_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!settingsCols.has('global_plugins_json')) {
    db.exec("ALTER TABLE settings ADD COLUMN global_plugins_json TEXT NOT NULL DEFAULT '[]'");
  }
  db.prepare(
    "INSERT OR IGNORE INTO settings (id, global_prompt, notifications_enabled, updated_at) VALUES (1, '', 1, ?)"
  ).run(Date.now());
}
