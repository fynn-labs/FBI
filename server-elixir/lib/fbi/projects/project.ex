defmodule FBI.Projects.Project do
  @moduledoc """
  Ecto schema for the `projects` table.

  One row per source-tree project registered with the server. The
  `*_json` TEXT columns store `Jason.encode!/1`-produced JSON strings; the
  `FBI.Projects.Queries` decode/1 function translates them to Elixir lists
  for the JSON response.

  Plain `Ecto.Schema` — no GenServer; all state lives in the DB.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :id, autogenerate: true}

  schema "projects" do
    field :name, :string
    field :repo_url, :string
    field :default_branch, :string, default: "main"
    field :devcontainer_override_json, :string
    field :instructions, :string
    field :git_author_name, :string
    field :git_author_email, :string
    field :marketplaces_json, :string, default: "[]"
    field :plugins_json, :string, default: "[]"
    field :mem_mb, :integer
    field :cpus, :float
    field :pids_limit, :integer
    field :created_at, :integer
    field :updated_at, :integer
  end

  @type t :: %__MODULE__{}

  @cast_fields ~w(
    name repo_url default_branch devcontainer_override_json instructions
    git_author_name git_author_email marketplaces_json plugins_json
    mem_mb cpus pids_limit created_at updated_at
  )a

  @doc "Changeset for insert or update of a project row."
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(project, attrs) do
    project
    |> cast(attrs, [:id | @cast_fields])
    |> validate_required([:name, :repo_url, :default_branch, :created_at, :updated_at])
    |> unique_constraint(:name)
  end
end
