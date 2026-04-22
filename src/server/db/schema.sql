CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  devcontainer_override_json TEXT,
  instructions TEXT,
  git_author_name TEXT,
  git_author_email TEXT,
  marketplaces_json TEXT NOT NULL DEFAULT '[]',
  plugins_json TEXT NOT NULL DEFAULT '[]',
  mem_mb INTEGER,
  cpus REAL,
  pids_limit INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_secrets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  state TEXT NOT NULL,
  container_id TEXT,
  log_path TEXT NOT NULL,
  exit_code INTEGER,
  error TEXT,
  head_commit TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  global_prompt TEXT NOT NULL DEFAULT '',
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  concurrency_warn_at INTEGER NOT NULL DEFAULT 3,
  image_gc_enabled INTEGER NOT NULL DEFAULT 0,
  last_gc_at INTEGER,
  last_gc_count INTEGER,
  last_gc_bytes INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO settings
  (id, global_prompt, notifications_enabled, concurrency_warn_at, image_gc_enabled, updated_at)
VALUES (1, '', 1, 3, 0, 0);
