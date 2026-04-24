defmodule FBI.Repo.Migrations.CreateSettingsTable do
  @moduledoc """
  Dev/test migration mirroring TS's `settings` table after all ALTER TABLE
  statements from `src/server/db/index.ts`.  TS remains the schema author in
  production; this migration exists only so `mix test` runs against the same
  column set.  At Phase 9 cutover, TS's schema.sql moves into `priv/repo/` and
  this file becomes the single source of truth.
  """

  use Ecto.Migration

  def change do
    create table(:settings, primary_key: false) do
      add :id, :integer,
        primary_key: true,
        check: %{name: "settings_id_singleton", expr: "id = 1"}

      add :global_prompt, :text, null: false, default: ""
      add :notifications_enabled, :integer, null: false, default: 1
      add :concurrency_warn_at, :integer, null: false, default: 3
      add :image_gc_enabled, :integer, null: false, default: 0
      add :last_gc_at, :integer
      add :last_gc_count, :integer
      add :last_gc_bytes, :integer
      add :global_marketplaces_json, :text, null: false, default: "[]"
      add :global_plugins_json, :text, null: false, default: "[]"
      add :auto_resume_enabled, :integer, null: false, default: 1
      add :auto_resume_max_attempts, :integer, null: false, default: 5
      add :usage_notifications_enabled, :integer, null: false, default: 0
      add :tokens_total_recomputed_at, :integer
      add :updated_at, :integer, null: false
    end
  end
end
