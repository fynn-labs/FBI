defmodule FBI.Mcp.Queries do
  @moduledoc "CRUD for `mcp_servers`. Handles global vs. project-scoped scoping explicitly."

  import Ecto.Query

  alias FBI.Mcp.Server
  alias FBI.Repo

  @type decoded :: %{
          id: integer(),
          project_id: integer() | nil,
          name: String.t(),
          type: String.t(),
          command: String.t() | nil,
          args: [String.t()],
          url: String.t() | nil,
          env: %{optional(String.t()) => String.t()},
          created_at: integer()
        }

  @spec list_global() :: [decoded()]
  def list_global do
    from(s in Server, where: is_nil(s.project_id), order_by: [asc: s.name])
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec list_for_project(integer()) :: [decoded()]
  def list_for_project(project_id) do
    from(s in Server, where: s.project_id == ^project_id, order_by: [asc: s.name])
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec get_global(integer()) :: {:ok, decoded()} | :not_found
  def get_global(id) do
    case Repo.get(Server, id) do
      %Server{project_id: nil} = s -> {:ok, decode(s)}
      _ -> :not_found
    end
  end

  @spec get_project(integer(), integer()) :: {:ok, decoded()} | :not_found
  def get_project(project_id, id) do
    case Repo.get(Server, id) do
      %Server{project_id: ^project_id} = s -> {:ok, decode(s)}
      _ -> :not_found
    end
  end

  @spec create(map()) :: {:ok, decoded()} | {:error, Ecto.Changeset.t()}
  def create(attrs) do
    now = System.system_time(:millisecond)
    attrs = encode_collections(attrs)

    %Server{}
    |> Server.changeset(Map.put(attrs, :created_at, now))
    |> Repo.insert()
    |> case do
      {:ok, s} -> {:ok, decode(s)}
      err -> err
    end
  end

  @spec update(%Server{}, map()) :: {:ok, decoded()} | {:error, Ecto.Changeset.t()}
  def update(%Server{} = s, patch) do
    s
    |> Server.changeset(encode_collections(patch))
    |> Repo.update()
    |> case do
      {:ok, u} -> {:ok, decode(u)}
      err -> err
    end
  end

  @spec delete(integer()) :: :ok
  def delete(id) do
    Repo.delete_all(from s in Server, where: s.id == ^id)
    :ok
  end

  defp encode_collections(attrs) do
    attrs
    |> maybe_encode_list(:args, :args_json)
    |> maybe_encode_map(:env, :env_json)
    |> Map.drop([:args, :env])
  end

  defp maybe_encode_list(attrs, in_key, out_key) do
    case Map.fetch(attrs, in_key) do
      {:ok, l} when is_list(l) -> Map.put(attrs, out_key, Jason.encode!(l))
      _ -> attrs
    end
  end

  defp maybe_encode_map(attrs, in_key, out_key) do
    case Map.fetch(attrs, in_key) do
      {:ok, m} when is_map(m) -> Map.put(attrs, out_key, Jason.encode!(m))
      _ -> attrs
    end
  end

  defp decode(%Server{} = s) do
    %{
      id: s.id,
      project_id: s.project_id,
      name: s.name,
      type: s.type,
      command: s.command,
      args: Jason.decode!(s.args_json || "[]"),
      url: s.url,
      env: Jason.decode!(s.env_json || "{}"),
      created_at: s.created_at
    }
  end
end
