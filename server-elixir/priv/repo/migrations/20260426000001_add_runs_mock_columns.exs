defmodule FBI.Repo.Migrations.AddRunsMockColumns do
  use Ecto.Migration

  def change do
    alter table(:runs) do
      add :mock, :boolean, default: false, null: false
      add :mock_scenario, :text
    end
  end
end
