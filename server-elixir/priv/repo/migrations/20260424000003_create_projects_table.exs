defmodule FBI.Repo.Migrations.CreateProjectsTable do
  @moduledoc """
  Dev/test migration mirroring TS's `projects` table after all ALTERs in
  `src/server/db/index.ts`. TS is the authoritative schema-owner in prod
  until Phase 9 (cutover).
  """

  use Ecto.Migration

  def change do
    create table(:projects, primary_key: false) do
      add :id, :integer, primary_key: true
      add :name, :text, null: false
      add :repo_url, :text, null: false
      add :default_branch, :text, null: false, default: "main"
      add :devcontainer_override_json, :text
      add :instructions, :text
      add :git_author_name, :text
      add :git_author_email, :text
      add :marketplaces_json, :text, null: false, default: "[]"
      add :plugins_json, :text, null: false, default: "[]"
      add :mem_mb, :integer
      add :cpus, :float
      add :pids_limit, :integer
      add :created_at, :integer, null: false
      add :updated_at, :integer, null: false
    end

    create unique_index(:projects, [:name])
  end
end
