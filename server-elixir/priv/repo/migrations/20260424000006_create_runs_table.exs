defmodule FBI.Repo.Migrations.CreateRunsTable do
  @moduledoc """
  Dev/test migration mirroring TS's `runs` table after all ALTER TABLEs in
  `src/server/db/index.ts`. Column order and nullability match TS so golden
  fidelity tests stay byte-compatible with TS responses.
  """

  use Ecto.Migration

  def change do
    create table(:runs, primary_key: false) do
      add :id, :integer, primary_key: true
      add :project_id, references(:projects, on_delete: :delete_all, type: :integer), null: false
      add :prompt, :text, null: false
      add :branch_name, :text, null: false
      add :state, :text, null: false
      add :container_id, :text
      add :log_path, :text, null: false
      add :exit_code, :integer
      add :error, :text
      add :head_commit, :text
      add :started_at, :integer
      add :finished_at, :integer
      add :created_at, :integer, null: false
      add :state_entered_at, :integer, null: false, default: 0
      add :model, :text
      add :effort, :text
      add :subagent_model, :text
      add :resume_attempts, :integer, null: false, default: 0
      add :next_resume_at, :integer
      add :claude_session_id, :text
      add :last_limit_reset_at, :integer
      add :tokens_input, :integer, null: false, default: 0
      add :tokens_output, :integer, null: false, default: 0
      add :tokens_cache_read, :integer, null: false, default: 0
      add :tokens_cache_create, :integer, null: false, default: 0
      add :tokens_total, :integer, null: false, default: 0
      add :usage_parse_errors, :integer, null: false, default: 0
      add :title, :text
      add :title_locked, :integer, null: false, default: 0
      add :parent_run_id, references(:runs, on_delete: :nilify_all, type: :integer)
    end

    create index(:runs, [:project_id], name: :idx_runs_project)
    create index(:runs, [:state], name: :idx_runs_state)
    create index(:runs, [:parent_run_id], name: :idx_runs_parent)
  end
end
