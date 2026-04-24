defmodule FBI.Projects.Queries do
  @moduledoc """
  Read/write helpers for the `projects` table plus the recent-prompts join.

  Plain module (no process state). Conventions:
  - Boolean-valued DB cols don't exist on this table (all ints/strings/floats).
  - List-valued cols are stored as JSON TEXT and decoded via `Jason`.
  - `get/1` returns `{:ok, decoded} | :not_found`; `delete/1` is idempotent.
  """

  import Ecto.Query

  alias FBI.Repo
  alias FBI.Projects.Project
  alias FBI.Runs.Run

  @type decoded :: %{
          id: integer(),
          name: String.t(),
          repo_url: String.t(),
          default_branch: String.t(),
          devcontainer_override_json: String.t() | nil,
          instructions: String.t() | nil,
          git_author_name: String.t() | nil,
          git_author_email: String.t() | nil,
          marketplaces: [String.t()],
          plugins: [String.t()],
          mem_mb: integer() | nil,
          cpus: float() | nil,
          pids_limit: integer() | nil,
          created_at: integer(),
          updated_at: integer()
        }

  @spec list() :: [decoded()]
  def list do
    Project
    |> order_by(desc: :updated_at)
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec get(integer()) :: {:ok, decoded()} | :not_found
  def get(id) do
    case Repo.get(Project, id) do
      nil -> :not_found
      p -> {:ok, decode(p)}
    end
  end

  @spec create(map()) :: {:ok, decoded()} | {:error, Ecto.Changeset.t()}
  def create(attrs) do
    now = System.system_time(:millisecond)
    attrs = encode_list_cols(attrs)
    row_attrs = Map.merge(attrs, %{created_at: now, updated_at: now})

    %Project{}
    |> Project.changeset(row_attrs)
    |> Repo.insert()
    |> case do
      {:ok, p} -> {:ok, decode(p)}
      {:error, cs} -> {:error, cs}
    end
  end

  @spec update(integer(), map()) :: {:ok, decoded()} | {:error, Ecto.Changeset.t()} | :not_found
  def update(id, patch) do
    case Repo.get(Project, id) do
      nil ->
        :not_found

      p ->
        now = System.system_time(:millisecond)

        p
        |> Project.changeset(Map.merge(encode_list_cols(patch), %{updated_at: now}))
        |> Repo.update()
        |> case do
          {:ok, u} -> {:ok, decode(u)}
          {:error, cs} -> {:error, cs}
        end
    end
  end

  @spec delete(integer()) :: :ok
  def delete(id) do
    Repo.delete_all(from p in Project, where: p.id == ^id)
    :ok
  end

  @doc """
  Returns up to `limit` distinct prompts for the given project, ordered by
  most-recent `created_at` desc (ties broken by MAX(id) desc). Mirrors TS's
  `listRecentPrompts` in `src/server/db/runs.ts:99-119`.
  """
  @spec list_recent_prompts(integer(), integer()) :: [
          %{prompt: String.t(), last_used_at: integer(), run_id: integer()}
        ]
  def list_recent_prompts(project_id, limit) do
    clamped = max(1, min(50, limit))

    from(r in Run,
      where: r.project_id == ^project_id,
      group_by: r.prompt,
      select: %{
        prompt: r.prompt,
        last_used_at: max(r.created_at),
        run_id: max(r.id)
      },
      order_by: [desc: max(r.created_at), desc: max(r.id)],
      limit: ^clamped
    )
    |> Repo.all()
  end

  defp encode_list_cols(attrs) do
    attrs
    |> maybe_encode(:marketplaces, :marketplaces_json)
    |> maybe_encode(:plugins, :plugins_json)
    |> Map.drop([:marketplaces, :plugins])
  end

  defp maybe_encode(attrs, in_key, out_key) do
    case Map.fetch(attrs, in_key) do
      {:ok, list} when is_list(list) -> Map.put(attrs, out_key, Jason.encode!(list))
      _ -> attrs
    end
  end

  defp decode(%Project{} = p) do
    %{
      id: p.id,
      name: p.name,
      repo_url: p.repo_url,
      default_branch: p.default_branch,
      devcontainer_override_json: p.devcontainer_override_json,
      instructions: p.instructions,
      git_author_name: p.git_author_name,
      git_author_email: p.git_author_email,
      marketplaces: Jason.decode!(p.marketplaces_json || "[]"),
      plugins: Jason.decode!(p.plugins_json || "[]"),
      mem_mb: p.mem_mb,
      cpus: p.cpus,
      pids_limit: p.pids_limit,
      created_at: p.created_at,
      updated_at: p.updated_at
    }
  end
end
