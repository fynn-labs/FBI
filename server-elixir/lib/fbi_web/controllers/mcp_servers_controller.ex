defmodule FBIWeb.McpServersController do
  @moduledoc """
  CRUD for MCP servers (global and project-scoped).

  Routes:
  - `GET  /api/mcp-servers` — list global
  - `POST /api/mcp-servers` — create global
  - `PATCH  /api/mcp-servers/:id` — 404 if row is project-scoped
  - `DELETE /api/mcp-servers/:id` — 404 if row is project-scoped
  - `GET  /api/projects/:id/mcp-servers` — list project-scoped
  - `POST /api/projects/:id/mcp-servers` — create with project_id
  - `PATCH  /api/projects/:id/mcp-servers/:sid` — 404 if mismatched project
  - `DELETE /api/projects/:id/mcp-servers/:sid` — 404 if mismatched project
  """

  use FBIWeb, :controller

  alias FBI.Mcp.{Queries, Server}
  alias FBI.Repo

  # ---- Global ----

  def index_global(conn, _params), do: json(conn, Queries.list_global())

  def create_global(conn, params) do
    attrs = atomize(params) |> Map.put(:project_id, nil)

    case Queries.create(attrs) do
      {:ok, s} -> conn |> put_status(201) |> json(s)
      {:error, cs} -> conn |> put_status(400) |> json(%{error: cs_msg(cs)})
    end
  end

  def patch_global(conn, %{"id" => id_str} = params) do
    patch = atomize(Map.delete(params, "id"))

    with {:ok, id} <- parse_id(id_str),
         {:ok, s} <- fetch_global(id),
         {:ok, updated} <- Queries.update(s, patch) do
      json(conn, updated)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def delete_global(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, _s} <- fetch_global(id) do
      Queries.delete(id)
      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  # ---- Project-scoped ----

  def index_project(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      {:ok, id} -> json(conn, Queries.list_for_project(id))
      :error -> json(conn, [])
    end
  end

  def create_project(conn, %{"id" => id_str} = params) do
    with {:ok, project_id} <- parse_id(id_str) do
      attrs = atomize(params) |> Map.put(:project_id, project_id)

      case Queries.create(attrs) do
        {:ok, s} -> conn |> put_status(201) |> json(s)
        {:error, cs} -> conn |> put_status(400) |> json(%{error: cs_msg(cs)})
      end
    else
      _ -> conn |> put_status(400) |> json(%{error: "invalid project id"})
    end
  end

  def patch_project(conn, %{"id" => id_str, "sid" => sid_str} = params) do
    patch = atomize(params |> Map.delete("id") |> Map.delete("sid"))

    with {:ok, project_id} <- parse_id(id_str),
         {:ok, sid} <- parse_id(sid_str),
         {:ok, s} <- fetch_project(project_id, sid),
         {:ok, updated} <- Queries.update(s, patch) do
      json(conn, updated)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def delete_project(conn, %{"id" => id_str, "sid" => sid_str}) do
    with {:ok, project_id} <- parse_id(id_str),
         {:ok, sid} <- parse_id(sid_str),
         {:ok, _s} <- fetch_project(project_id, sid) do
      Queries.delete(sid)
      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  # ---- Helpers ----

  defp fetch_global(id) do
    case Repo.get(Server, id) do
      %Server{project_id: nil} = s -> {:ok, s}
      _ -> :not_found
    end
  end

  defp fetch_project(project_id, sid) do
    case Repo.get(Server, sid) do
      %Server{project_id: ^project_id} = s -> {:ok, s}
      _ -> :not_found
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  @allowed ~w(name type command args url env)
  @known_string_keys Map.new(@allowed, fn k -> {k, String.to_atom(k)} end)

  defp atomize(params) when is_map(params) do
    Enum.reduce(@known_string_keys, %{}, fn {k, a}, acc ->
      case Map.fetch(params, k) do
        {:ok, v} -> Map.put(acc, a, v)
        :error -> acc
      end
    end)
  end

  defp cs_msg(%Ecto.Changeset{errors: [{f, {m, _}} | _]}), do: "#{f} #{m}"
  defp cs_msg(_), do: "invalid input"
end
