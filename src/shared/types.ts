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
  created_at: number;
  updated_at: number;
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
}

export interface SecretName {
  name: string;
  created_at: number;
}

export interface Settings {
  global_prompt: string;
  updated_at: number;
}
