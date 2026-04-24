defmodule FBIWeb.CliController do
  @moduledoc """
  Serves cross-compiled `fbi-tunnel` binaries to end-user laptops.

  Single route:

  - `GET /api/cli/fbi-tunnel/:os/:arch` — returns the binary as an octet
    stream.  Allowed pairs: `{darwin, linux} × {amd64, arm64}`.

  The binary is streamed from disk with `Plug.Conn.send_file/3` to avoid
  buffering large files into memory.  `send_file` uses the BEAM sendfile(2)
  path on Linux, so the data goes kernel-socket→kernel-socket without
  entering userspace.

  Configuration:

    * `:cli_dist_dir` — directory on disk holding the per-os/arch binaries.
      Defaults to `"dist/cli"`.  Overridable via `CLI_DIST_DIR` in prod.
    * `:fbi_cli_version` — string surfaced via the `X-FBI-CLI-Version`
      header when set.  `nil` (the default) omits the header.
  """

  use FBIWeb, :controller

  # Allow-lists are compile-time constants so the set membership check is a
  # simple `in` expression rather than a runtime Set lookup.
  @allowed_os ~w(darwin linux)
  @allowed_arch ~w(amd64 arm64)

  @doc """
  GET /api/cli/fbi-tunnel/:os/:arch — validate, then stream the binary.
  """
  def fbi_tunnel(conn, %{"os" => os_param, "arch" => arch_param}) do
    cond do
      os_param not in @allowed_os or arch_param not in @allowed_arch ->
        conn |> put_status(400) |> json(%{error: "unsupported os/arch"})

      true ->
        filename = "fbi-tunnel-#{os_param}-#{arch_param}"
        dir = Application.fetch_env!(:fbi, :cli_dist_dir)
        file_path = Path.join(dir, filename)

        case File.stat(file_path) do
          {:ok, _stat} ->
            # Use `put_resp_header/3` rather than `put_resp_content_type/2` —
            # the latter appends `; charset=utf-8`, which is wrong for a raw
            # binary payload.  Phoenix will not override an already-set
            # content-type on send_file.
            conn
            |> put_resp_header("content-type", "application/octet-stream")
            |> put_resp_header("content-disposition", ~s(attachment; filename="#{filename}"))
            |> put_resp_header("cache-control", "public, max-age=3600")
            |> maybe_put_version_header()
            |> send_file(200, file_path)

          {:error, _reason} ->
            # 503, not 404: the binary is expected to exist in a correctly-built
            # deployment; its absence is a *server* misconfiguration (not yet
            # built / wrong path), not a *request* problem.  Matches TS.
            conn
            |> put_status(503)
            |> json(%{error: "fbi-tunnel binary not built; rerun npm run build"})
        end
    end
  end

  # Append the CLI-version header only when configured; otherwise the UI
  # treats "no header" as "unknown version", which matches the TS behaviour.
  defp maybe_put_version_header(conn) do
    case Application.get_env(:fbi, :fbi_cli_version) do
      nil -> conn
      "" -> conn
      version when is_binary(version) -> put_resp_header(conn, "x-fbi-cli-version", version)
    end
  end
end
