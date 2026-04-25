defmodule FBIWeb.TranscriptController do
  @moduledoc "GET /api/runs/:id/transcript — serves log file with Range and X-Transcript-Total support."
  use FBIWeb, :controller

  import Plug.Conn

  alias FBI.Runs.{LogStore, Queries}

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      total = LogStore.byte_size(run.log_path)

      conn =
        conn
        |> put_resp_header("content-type", "text/plain; charset=utf-8")
        |> put_resp_header("x-transcript-total", Integer.to_string(total))

      if total == 0 do
        send_resp(conn, 200, "")
      else
        range_header = conn |> get_req_header("range") |> List.first()

        case parse_range(range_header, total) do
          nil ->
            send_resp(conn, 200, LogStore.read_all(run.log_path))

          {:ok, start_offset, end_offset} ->
            body = LogStore.read_range(run.log_path, start_offset, end_offset)

            conn
            |> put_resp_header("content-range", "bytes #{start_offset}-#{end_offset}/#{total}")
            |> send_resp(206, body)

          :invalid ->
            conn
            |> put_resp_header("content-range", "bytes */#{total}")
            |> send_resp(416, "")
        end
      end
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

  defp parse_range(nil, _total), do: nil

  defp parse_range(header, total) do
    case Regex.run(~r/^bytes=(\d+)-(\d*)$/i, String.trim(header)) do
      [_, start_str, end_str] ->
        start_offset = String.to_integer(start_str)
        requested_end = if end_str == "", do: total - 1, else: String.to_integer(end_str)

        cond do
          start_offset >= total -> :invalid
          start_offset > requested_end -> :invalid
          true -> {:ok, start_offset, min(requested_end, total - 1)}
        end

      _ ->
        nil
    end
  end
end
