defmodule FBIWeb.ProxyController do
  @moduledoc """
  Exposes container-level networking introspection to the client.

  Mirrors the TS implementation in `src/server/api/proxy.ts:47-65`. The TS
  code reads `/proc/<pid>/net/tcp` on the host using the container's main
  PID. We don't have host-PID access from BEAM, so we exec
  `cat /proc/net/tcp` inside the container — same content, no host-side PID
  lookup required.
  """

  use FBIWeb, :controller

  alias FBI.Proxy.ProcListeners
  alias FBI.Runs.Queries

  @doc """
  GET /api/runs/:id/listening-ports

  * 404 — run not found
  * 409 — run has no live container (never started, or already torn down)
  * 400 — id is not an integer
  * 500 — docker exec failed
  """
  def listening_ports(conn, %{"id" => id_str}) do
    with {:ok, run_id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(run_id),
         cid when is_binary(cid) and cid != "" <- run.container_id,
         {:ok, exec_id} <- FBI.Docker.exec_create(cid, ["cat", "/proc/net/tcp"]),
         {:ok, output} <- FBI.Docker.exec_start(exec_id, timeout_ms: 3_000) do
      json(conn, %{ports: ProcListeners.parse(output)})
    else
      :not_found ->
        conn |> put_status(404) |> json(%{error: "run not found"})

      nil ->
        conn |> put_status(409) |> json(%{error: "run not running"})

      "" ->
        conn |> put_status(409) |> json(%{error: "run not running"})

      :error ->
        conn |> put_status(400) |> json(%{error: "invalid run id"})

      _ ->
        conn |> put_status(500) |> json(%{error: "exec failed"})
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
