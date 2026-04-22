export type RunState =
  | 'queued'
  | 'running'
  | 'awaiting_resume'
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
  resume_attempts: number;
  next_resume_at: number | null;
  claude_session_id: string | null;
  last_limit_reset_at: number | null;
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
  auto_resume_enabled: boolean;
  auto_resume_max_attempts: number;
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

export type RunWsStateMessage = {
  type: 'state';
  state: RunState;
  next_resume_at: number | null;
  resume_attempts: number;
  last_limit_reset_at: number | null;
};
