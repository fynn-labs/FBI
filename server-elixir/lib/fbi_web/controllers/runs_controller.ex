defmodule FBIWeb.RunsController do
  @moduledoc """
  Runs read + non-orchestrator mutations. PATCH updates title; DELETE removes
  the row and, for active runs, issues a Docker kill via the socket client.
  """

  use FBIWeb, :controller

  alias FBI.Runs.Queries

  def index(conn, params) do
    parsed = %{
      state: params["state"],
      project_id: parse_int(params["project_id"]),
      q: params["q"],
      limit: parse_int(params["limit"]),
      offset: parse_int(params["offset"])
    }

    json(conn, Queries.list(parsed))
  end

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      json(conn, run)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def index_for_project(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      {:ok, pid} -> json(conn, Queries.list_for_project(pid))
      _ -> json(conn, [])
    end
  end

  def siblings(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, list} <- Queries.siblings(id) do
      json(conn, list)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def patch_title(conn, %{"id" => id_str} = params) do
    title =
      case params["title"] do
        t when is_binary(t) -> String.trim(t)
        _ -> nil
      end

    with {:ok, id} <- parse_id(id_str),
         true <- is_binary(title) and byte_size(title) > 0 and byte_size(title) <= 120,
         {:ok, run} <- Queries.update_title(id, title) do
      json(conn, run)
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
      _ -> conn |> put_status(400) |> json(%{error: "invalid title"})
    end
  end

  def delete(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      if run.state in ["running", "awaiting_resume", "starting"] do
        if run.container_id, do: FBI.Docker.kill(run.container_id)
      end

      Queries.delete(id)

      if run.log_path, do: File.rm(run.log_path)

      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  defp parse_int(nil), do: nil

  defp parse_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, _} -> n
      :error -> nil
    end
  end
end
