export type RunState =
  | 'queued'
  | 'running'
  | 'waiting'
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
  default_merge_strategy: 'merge' | 'rebase' | 'squash';
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
  state_entered_at: number;
  resume_attempts: number;
  next_resume_at: number | null;
  claude_session_id: string | null;
  last_limit_reset_at: number | null;
  // Usage totals (see docs/superpowers/specs/2026-04-22-claude-usage-design.md)
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
  tokens_total: number;
  usage_parse_errors: number;
  title: string | null;
  title_locked: 0 | 1;
  parent_run_id: number | null;
  kind: 'work' | 'merge-conflict' | 'polish';
  kind_args_json: string | null;
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
  usage_notifications_enabled: boolean;
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
  state_entered_at: number;
  next_resume_at: number | null;
  resume_attempts: number;
  last_limit_reset_at: number | null;
};

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

export interface UsageBucket {
  id: string;
  utilization: number;                 // 0..1
  reset_at: number | null;
  window_started_at: number | null;
}

export type PacingZone = 'chill' | 'on_track' | 'hot' | 'none';

export interface PacingVerdict {
  delta: number;                       // signed; > 0 = over budget
  zone: PacingZone;
}

export type UsageError =
  | 'missing_credentials'
  | 'expired'
  | 'rate_limited'
  | 'network'
  | null;

export interface UsageState {
  plan: 'pro' | 'max' | 'team' | null;
  observed_at: number | null;
  last_error: UsageError;
  last_error_at: number | null;
  buckets: UsageBucket[];
  pacing: Record<string, PacingVerdict>;
}

export type UsageWsSnapshotMessage = { type: 'snapshot'; state: UsageState };
export type UsageWsThresholdMessage = {
  type: 'threshold_crossed';
  bucket_id: string;
  threshold: 75 | 90;
  reset_at: number | null;
};
export type UsageWsMessage = UsageWsSnapshotMessage | UsageWsThresholdMessage;

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
export type RunWsTitleMessage = {
  type: 'title';
  title: string | null;
  title_locked: 0 | 1;
};

export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';

export interface FilesDirtyEntry {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface FilesHeadEntry {
  path: string;
  status: Exclude<FileStatus, 'U'>;
  additions: number;
  deletions: number;
}

export interface FilesPayload {
  dirty: FilesDirtyEntry[];
  head: { sha: string; subject: string } | null;
  headFiles: FilesHeadEntry[];
  branchBase: { base: string; ahead: number; behind: number } | null;
  live: boolean;
}

export type MergeStrategy = 'merge' | 'rebase' | 'squash';

export type HistoryOp =
  | { op: 'merge'; strategy?: MergeStrategy }
  | { op: 'sync' }
  | { op: 'squash-local'; subject: string }
  | { op: 'polish' };

export type HistoryResult =
  | { kind: 'complete'; sha?: string }
  | { kind: 'agent'; child_run_id: number }
  | { kind: 'conflict'; child_run_id: number }
  | { kind: 'agent-busy' }
  | { kind: 'invalid'; message: string }
  | { kind: 'git-unavailable' };

export interface ChangeCommit {
  sha: string;
  subject: string;
  committed_at: number;
  pushed: boolean;
  files: FilesHeadEntry[];
  files_loaded: boolean;
}

export interface ChangesPayload {
  branch_name: string | null;
  branch_base: { base: string; ahead: number; behind: number } | null;
  commits: ChangeCommit[];
  uncommitted: FilesDirtyEntry[];
  integrations: {
    github?: {
      pr: { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string } | null;
      checks: {
        state: 'pending' | 'success' | 'failure';
        passed: number;
        failed: number;
        total: number;
        items: GithubCheckItem[];
      } | null;
    };
  };
}

export type RunWsChangesMessage = { type: 'changes' } & ChangesPayload;

export interface GithubCommit {
  sha: string;
  subject: string;
  committed_at: number;
  pushed: boolean;
}

export interface GithubCheckItem {
  name: string;
  status: 'pending' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled' | null;
  duration_ms: number | null;
}

export interface GithubPayload {
  pr: { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string } | null;
  checks: {
    state: 'pending' | 'success' | 'failure';
    passed: number;
    failed: number;
    total: number;
    items: GithubCheckItem[];
  } | null;
  commits: GithubCommit[];
  github_available: boolean;
}

export type MergeResponse =
  | { merged: true; sha: string }
  | { merged: false; reason: 'conflict'; agent: true }
  | { merged: false; reason: 'conflict' | 'agent-busy' | 'gh-not-available' | 'not-github' | 'no-branch' | 'no-pr' | 'gh-error' | 'already-merged'; agent?: false };

export interface FileDiffHunk {
  header: string;
  lines: Array<{ kind: 'ctx' | 'add' | 'del'; text: string }>;
}

export interface FileDiffPayload {
  path: string;
  ref: 'worktree' | string;
  hunks: FileDiffHunk[];
  truncated: boolean;
}

export interface GlobalStateMessage {
  type: 'state';
  run_id: number;
  project_id: number;
  state: RunState;
  state_entered_at: number;
  next_resume_at: number | null;
  resume_attempts: number;
  last_limit_reset_at: number | null;
}

/** Sent by the server as the opening text frame on live WS connect, and in
 *  response to a client-initiated resync. Carries the current screen state
 *  as an ANSI string that reproduces the screen when written into a fresh
 *  xterm of the same cols/rows. */
export interface RunWsSnapshotMessage {
  type: 'snapshot';
  ansi: string;
  cols: number;
  rows: number;
}

/** Sent by the client on window refocus / visibilitychange->visible to ask
 *  the server for a fresh snapshot frame. Body carries no payload. */
export interface RunWsResyncMessage {
  type: 'resync';
}

export interface ListeningPort {
  port: number;
  proto: 'tcp';
}

export interface UploadedFile {
  filename: string;
  size: number;
  uploaded_at: number;
}

export interface DraftUploadResponse extends UploadedFile {
  draft_token: string;
}
