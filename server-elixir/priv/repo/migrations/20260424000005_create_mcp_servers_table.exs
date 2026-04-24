defmodule FBI.Repo.Migrations.CreateMcpServersTable do
  @moduledoc """
  Dev/test migration mirroring TS's `mcp_servers`. Global rows have
  `project_id IS NULL`; project-scoped rows have a non-null project_id.
  The partial unique index enforces global-name uniqueness separately
  from per-project uniqueness.
  """

  use Ecto.Migration

  def change do
    create table(:mcp_servers, primary_key: false) do
      add :id, :integer, primary_key: true
      add :project_id, references(:projects, on_delete: :delete_all, type: :integer)
      add :name, :text, null: false
      add :type, :text, null: false
      add :command, :text
      add :args_json, :text, null: false, default: "[]"
      add :url, :text
      add :env_json, :text, null: false, default: "{}"
      add :created_at, :integer, null: false

      constraint(:type, check: "type IN ('stdio','sse')")
    end

    create unique_index(:mcp_servers, [:project_id, :name])

    execute(
      "CREATE UNIQUE INDEX idx_mcp_servers_global_name ON mcp_servers(name) WHERE project_id IS NULL",
      "DROP INDEX IF EXISTS idx_mcp_servers_global_name"
    )
  end
end
