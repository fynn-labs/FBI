defmodule FBIWeb.UploadsController do
  @moduledoc """
  Run uploads: list, add, delete.

  State rules (from TS):
  - Add/delete: run must be in state `running` or `waiting` → 409 otherwise with
    `{ error: "wrong_state" }`.
  - Quota: 1 GB cumulative per run.
  - Filename: validated + deduplicated via `FBI.Uploads.FS`.
  """

  use FBIWeb, :controller

  alias FBI.Runs.Queries, as: Runs
  alias FBI.Uploads.{FS, Paths}

  @quota_bytes 1024 * 1024 * 1024

  def index(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      :error ->
        conn |> put_status(404) |> json(%{error: "not_found"})

      {:ok, id} ->
        case Runs.get(id) do
          :not_found ->
            conn |> put_status(404) |> json(%{error: "not_found"})

          {:ok, _run} ->
            dir = Paths.run_uploads_dir(id)
            files = list_files(dir)
            json(conn, %{files: files})
        end
    end
  end

  def create(conn, %{"id" => id_str} = params) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         true <- run.state in ["running", "waiting"] or {:error, :wrong_state},
         %Plug.Upload{path: src, filename: raw_name} <- Map.get(params, "file"),
         {:ok, sanitized} <- FS.sanitize_filename(raw_name),
         dir <- ensure_dir(Paths.run_uploads_dir(id)),
         :ok <- check_quota(dir),
         {:ok, resolved} <- FS.resolve_filename(dir, sanitized),
         :ok <- copy_file(src, Path.join(dir, resolved)) do
      size = File.stat!(Path.join(dir, resolved)).size
      now = System.system_time(:millisecond)

      append_notice(run.log_path, resolved, size)

      json(conn, %{filename: resolved, size: size, uploaded_at: now})
    else
      :not_found ->
        conn |> put_status(404) |> json(%{error: "not_found"})

      {:error, :wrong_state} ->
        conn |> put_status(409) |> json(%{error: "wrong_state"})

      {:error, :invalid} ->
        conn |> put_status(400) |> json(%{error: "invalid_filename"})

      {:error, :quota_exceeded} ->
        conn |> put_status(413) |> json(%{error: "run_quota_exceeded"})

      {:error, :collision_overflow} ->
        conn |> put_status(500) |> json(%{error: "collision_overflow"})

      _ ->
        conn |> put_status(500) |> json(%{error: "io_error"})
    end
  end

  def delete(conn, %{"id" => id_str, "filename" => raw_name}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         true <- run.state in ["running", "waiting"] or {:error, :wrong_state},
         {:ok, sanitized} <- FS.sanitize_filename(raw_name),
         path <- Path.join(Paths.run_uploads_dir(id), sanitized),
         true <- File.exists?(path) or {:error, :not_found},
         :ok <- File.rm(path) do
      send_resp(conn, 204, "")
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not_found"})
      {:error, :wrong_state} -> conn |> put_status(409) |> json(%{error: "wrong_state"})
      {:error, :invalid} -> conn |> put_status(400) |> json(%{error: "invalid_filename"})
      {:error, :not_found} -> conn |> put_status(404) |> json(%{error: "not_found"})
      _ -> conn |> put_status(500) |> json(%{error: "io_error"})
    end
  end

  defp list_files(dir) do
    case File.ls(dir) do
      {:ok, entries} ->
        entries
        |> Enum.reject(&String.ends_with?(&1, ".part"))
        |> Enum.map(fn name ->
          path = Path.join(dir, name)

          case File.stat(path) do
            {:ok, %File.Stat{type: :regular, size: sz, mtime: mt}} ->
              %{filename: name, size: sz, uploaded_at: erl_to_ms(mt)}

            _ ->
              nil
          end
        end)
        |> Enum.reject(&is_nil/1)

      _ ->
        []
    end
  end

  defp ensure_dir(dir) do
    File.mkdir_p!(dir)
    dir
  end

  defp check_quota(dir) do
    if FBI.Uploads.FS.directory_bytes(dir) >= @quota_bytes do
      {:error, :quota_exceeded}
    else
      :ok
    end
  end

  defp copy_file(src, dest) do
    case File.cp(src, dest) do
      :ok -> :ok
      err -> err
    end
  end

  defp append_notice(log_path, filename, size) when is_binary(log_path) do
    File.write(
      log_path,
      "[fbi] user uploaded #{filename} (#{FBI.Uploads.HumanSize.format(size)})\n",
      [:append]
    )
  end

  defp append_notice(_, _, _), do: :ok

  defp erl_to_ms({{y, m, d}, {h, mi, s}}) do
    {:ok, dt} = NaiveDateTime.new(y, m, d, h, mi, s)
    dt |> DateTime.from_naive!("Etc/UTC") |> DateTime.to_unix(:millisecond)
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
