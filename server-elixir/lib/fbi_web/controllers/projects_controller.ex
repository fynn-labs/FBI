defmodule FBIWeb.ProjectsController do
  @moduledoc """
  CRUD for projects plus the "recent prompts" per-project query.

  Mirrors `src/server/api/projects.ts`. The list view augments each project
  with an optional `last_run` field (id + state + created_at) matching TS's
  shape; the detail view does *not* include `last_run`.
  """

  use FBIWeb, :controller

  alias FBI.Projects.Queries
  alias FBI.Runs.Queries, as: RunsQueries

  @allowed_patch_keys ~w(
    name repo_url default_branch devcontainer_override_json instructions
    git_author_name git_author_email marketplaces plugins mem_mb cpus pids_limit
  )

  def index(conn, _params) do
    list = Queries.list()
    augmented = Enum.map(list, fn p ->
      Map.put(p, :last_run, RunsQueries.latest_for_project(p.id))
    end)
    json(conn, augmented)
  end

  def create(conn, params) do
    attrs = atomize(params)

    case Queries.create(attrs) do
      {:ok, p} ->
        conn |> put_status(201) |> json(p)

      {:error, cs} ->
        conn |> put_status(400) |> json(%{error: invalid_body_reason(cs)})
    end
  end

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, p} <- Queries.get(id) do
      json(conn, p)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def update(conn, %{"id" => id_str} = params) do
    patch = atomize(Map.delete(params, "id"))

    with {:ok, id} <- parse_id(id_str),
         {:ok, p} <- Queries.update(id, patch) do
      json(conn, p)
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
      {:error, cs} -> conn |> put_status(400) |> json(%{error: invalid_body_reason(cs)})
      _ -> conn |> put_status(400) |> json(%{error: "invalid id"})
    end
  end

  def delete(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      {:ok, id} ->
        Queries.delete(id)
        send_resp(conn, 204, "")

      :error ->
        # TS returns 204 unconditionally — match that.
        send_resp(conn, 204, "")
    end
  end

  def recent_prompts(conn, %{"id" => id_str} = params) do
    limit =
      case params["limit"] do
        nil ->
          10

        s when is_binary(s) ->
          case Integer.parse(s) do
            {n, _} -> n
            :error -> 10
          end
      end

    case parse_id(id_str) do
      {:ok, id} ->
        json(conn, Queries.list_recent_prompts(id, limit))

      :error ->
        json(conn, [])
    end
  end

  defp parse_id(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  @known_string_keys Map.new(@allowed_patch_keys, fn k -> {k, String.to_atom(k)} end)

  defp atomize(params) when is_map(params) do
    Enum.reduce(@known_string_keys, %{}, fn {string_key, atom_key}, acc ->
      case Map.fetch(params, string_key) do
        {:ok, v} -> Map.put(acc, atom_key, v)
        :error -> acc
      end
    end)
  end

  defp invalid_body_reason(%Ecto.Changeset{errors: errors}) do
    case errors do
      [{field, {msg, _}} | _] -> "#{field} #{msg}"
      _ -> "invalid project"
    end
  end
end
