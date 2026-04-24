defmodule FBIWeb.TranscriptController do
  @moduledoc "GET /api/runs/:id/transcript — serves the entire log file as text/plain."
  use FBIWeb, :controller

  alias FBI.Runs.{LogStore, Queries}

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      body = LogStore.read_all(run.log_path)

      conn
      |> put_resp_header("content-type", "text/plain; charset=utf-8")
      |> send_resp(200, body)
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
end
