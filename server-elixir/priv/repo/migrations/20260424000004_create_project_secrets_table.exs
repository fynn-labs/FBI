defmodule FBI.Repo.Migrations.CreateProjectSecretsTable do
  @moduledoc """
  Dev/test migration mirroring TS's `project_secrets`. `value_enc` is a BLOB
  containing `nonce(12) || ciphertext || tag(16)` produced by AES-256-GCM
  — see `FBI.Crypto` and the cross-language round-trip fixture.
  """

  use Ecto.Migration

  def change do
    create table(:project_secrets, primary_key: false) do
      add :id, :integer, primary_key: true
      add :project_id, references(:projects, on_delete: :delete_all, type: :integer), null: false
      add :name, :text, null: false
      add :value_enc, :binary, null: false
      add :created_at, :integer, null: false
    end

    create unique_index(:project_secrets, [:project_id, :name])
  end
end
