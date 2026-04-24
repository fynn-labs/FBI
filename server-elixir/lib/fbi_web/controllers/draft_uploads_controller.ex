defmodule FBIWeb.DraftUploadsController do
  @moduledoc """
  Draft upload endpoints used before a run is created. Files live in
  `{draft_uploads_dir}/{token}/` and are promoted to `{runs_dir}/{id}/uploads/`
  by the orchestrator when a run is created with `draft_token`.

  The hourly GC in `FBI.Housekeeping.DraftUploadsGc` deletes aged tokens.
  """

  use FBIWeb, :controller

  alias FBI.Uploads.{FS, Paths}

  @quota_bytes 1024 * 1024 * 1024

  def create(conn, params) do
    token =
      case conn.query_params["draft_token"] do
        nil -> FS.draft_token()
        t -> if FS.valid_draft_token?(t), do: t, else: :invalid
      end

    with :not_invalid <- if(token == :invalid, do: :invalid, else: :not_invalid),
         %Plug.Upload{path: src, filename: raw_name} <- Map.get(params, "file"),
         {:ok, sanitized} <- FS.sanitize_filename(raw_name),
         dir <- ensure_dir(Paths.draft_dir(token)),
         :ok <- check_quota(dir),
         {:ok, resolved} <- FS.resolve_filename(dir, sanitized),
         :ok <- File.cp(src, Path.join(dir, resolved)) do
      size = File.stat!(Path.join(dir, resolved)).size
      now = System.system_time(:millisecond)
      json(conn, %{draft_token: token, filename: resolved, size: size, uploaded_at: now})
    else
      :invalid ->
        conn |> put_status(400) |> json(%{error: "invalid_token"})

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

  def delete(conn, %{"token" => token, "filename" => raw_name}) do
    with true <- FS.valid_draft_token?(token) or {:error, :invalid_token},
         {:ok, sanitized} <- FS.sanitize_filename(raw_name),
         path <- Path.join(Paths.draft_dir(token), sanitized),
         true <- File.exists?(path) or {:error, :not_found},
         :ok <- File.rm(path) do
      send_resp(conn, 204, "")
    else
      {:error, :invalid_token} -> conn |> put_status(400) |> json(%{error: "invalid_token"})
      {:error, :invalid} -> conn |> put_status(400) |> json(%{error: "invalid_filename"})
      {:error, :not_found} -> conn |> put_status(404) |> json(%{error: "not_found"})
      _ -> conn |> put_status(500) |> json(%{error: "io_error"})
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
end
