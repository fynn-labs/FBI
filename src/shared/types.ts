export type RunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Project {
  id: number;
  name: string;
  repo_url: string;
  default_branch: string;
  devcontainer_override_json: string | null;
  instructions: string | null;
  git_author_name: string | null;
  git_author_email: string | null;
  marketplaces: string[];
  plugins: string[];
  mem_mb: number | null;
  cpus: number | null;
  pids_limit: number | null;
  created_at: number;
  updated_at: number;
  last_run?: { id: number; state: RunState; created_at: number } | null;
}

export interface Run {
  id: number;
  project_id: number;
  prompt: string;
  branch_name: string;
  state: RunState;
  container_id: string | null;
  log_path: string;
  exit_code: number | null;
  error: string | null;
  head_commit: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  // Usage totals (see docs/superpowers/specs/2026-04-22-claude-usage-design.md)
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
  tokens_total: number;
  usage_parse_errors: number;
}

export interface SecretName {
  name: string;
  created_at: number;
}

export interface Settings {
  global_prompt: string;
  notifications_enabled: boolean;
  concurrency_warn_at: number;
  image_gc_enabled: boolean;
  last_gc_at: number | null;
  last_gc_count: number | null;
  last_gc_bytes: number | null;
  global_marketplaces: string[];
  global_plugins: string[];
  updated_at: number;
}

export interface McpServer {
  id: number;
  project_id: number | null;
  name: string;
  type: 'stdio' | 'sse';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  created_at: number;
}

export interface UsageSnapshot {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

export interface RateLimitSnapshot {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;
}

export interface RateLimitState {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;
  observed_at: number | null;
  observed_from_run_id: number | null;
  percent_used: number | null;
  reset_in_seconds: number | null;
  observed_seconds_ago: number | null;
}

export interface DailyUsage {
  date: string;
  tokens_total: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
  run_count: number;
}

export interface RunUsageBreakdownRow {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export type RunWsUsageMessage = { type: 'usage'; snapshot: UsageSnapshot };
export type RunWsRateLimitMessage = { type: 'rate_limit'; snapshot: RateLimitState };
