defmodule FBI.Projects.Secret do
  @moduledoc "Ecto schema for `project_secrets`. `value_enc` is an AES-GCM blob."
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :id, autogenerate: true}

  schema "project_secrets" do
    field :project_id, :integer
    field :name, :string
    field :value_enc, :binary
    field :created_at, :integer
  end

  @type t :: %__MODULE__{}

  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(secret, attrs) do
    secret
    |> cast(attrs, [:id, :project_id, :name, :value_enc, :created_at])
    |> validate_required([:project_id, :name, :value_enc, :created_at])
    |> unique_constraint([:project_id, :name])
  end
end
