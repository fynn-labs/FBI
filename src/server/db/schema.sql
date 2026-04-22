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
-- Seed row for settings is inserted by migrate() in index.ts, AFTER any
-- needed ALTER TABLEs have added columns that may be missing on upgraded
-- databases. Seeding here would fail on a pre-existing settings table that
-- doesn't yet have the new columns.

CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('stdio','sse')),
  command TEXT,
  args_json TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  env_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_global_name
  ON mcp_servers(name) WHERE project_id IS NULL;

-- Claude usage capture (see docs/superpowers/specs/2026-04-22-claude-usage-design.md)
-- New columns on runs for denormalized token totals are added via migrate()
-- in index.ts so upgraded DBs stay consistent with fresh ones.

CREATE TABLE IF NOT EXISTS run_usage_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_create_tokens INTEGER NOT NULL,
  rl_requests_remaining INTEGER,
  rl_requests_limit INTEGER,
  rl_tokens_remaining INTEGER,
  rl_tokens_limit INTEGER,
  rl_reset_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_usage_events_run ON run_usage_events (run_id, ts);
CREATE INDEX IF NOT EXISTS idx_run_usage_events_ts  ON run_usage_events (ts);

-- Auto-resume on rate-limit: extra columns on `runs` and `settings`
-- are added via migrate() in index.ts.

CREATE TABLE IF NOT EXISTS rate_limit_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  requests_remaining INTEGER,
  requests_limit INTEGER,
  tokens_remaining INTEGER,
  tokens_limit INTEGER,
  reset_at INTEGER,
  observed_at INTEGER NOT NULL,
  observed_from_run_id INTEGER
);
