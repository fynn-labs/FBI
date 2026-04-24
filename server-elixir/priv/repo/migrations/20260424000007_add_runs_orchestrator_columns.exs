defmodule FBI.Repo.Migrations.AddRunsOrchestratorColumns do
  use Ecto.Migration

  @moduledoc """
  Adds columns needed by the Phase 7 orchestrator.

  - `kind`          — run type: 'work' | 'merge-conflict' | 'polish'
  - `kind_args_json`— JSON args for non-work sub-runs
  - `mirror_status` — set by MirrorStatusPoller: 'ok' | 'diverged' | 'local_only'

  Dev/test migration only; TS's `src/server/db/index.ts` owns the prod schema
  until Phase 9.
  """

  def change do
    alter table(:runs) do
      add :kind, :text, default: "work", null: false
      add :kind_args_json, :text
      add :mirror_status, :text
    end
  end
end
