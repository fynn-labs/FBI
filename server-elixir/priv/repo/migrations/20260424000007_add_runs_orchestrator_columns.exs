defmodule FBI.Repo.Migrations.AddRunsOrchestratorColumns do
  use Ecto.Migration

  def change do
    alter table(:runs) do
      add :kind, :text, default: "work", null: false
      add :kind_args_json, :text
      add :mirror_status, :text
    end
  end
end
