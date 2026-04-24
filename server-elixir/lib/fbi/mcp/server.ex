defmodule FBI.Mcp.Server do
  @moduledoc """
  Ecto schema for `mcp_servers`. A `nil` project_id indicates a global
  server; an integer indicates a project-scoped server. `args_json` and
  `env_json` are JSON TEXT columns decoded by `FBI.Mcp.Queries`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :id, autogenerate: true}

  schema "mcp_servers" do
    field :project_id, :integer
    field :name, :string
    field :type, :string
    field :command, :string
    field :args_json, :string, default: "[]"
    field :url, :string
    field :env_json, :string, default: "{}"
    field :created_at, :integer
  end

  @type t :: %__MODULE__{}

  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(srv, attrs) do
    srv
    |> cast(attrs, [:id, :project_id, :name, :type, :command, :args_json, :url, :env_json, :created_at])
    |> validate_required([:name, :type, :created_at])
    |> validate_inclusion(:type, ["stdio", "sse"])
    |> unique_constraint([:project_id, :name])
  end
end
