defmodule FBIWeb.ProxySocketController do
  @moduledoc """
  Controller that handles the `/api/runs/:id/proxy/:port` HTTP request and
  upgrades it to a WebSocket connection managed by
  `FBIWeb.Sockets.ProxyWSHandler`.

  Mirror of `FBIWeb.UsageSocketController` — kept as a thin router target so
  the WebSock callback module isn't loaded as a Phoenix controller (which
  would collide on `init/1`).
  """

  use FBIWeb, :controller

  alias FBIWeb.Sockets.ProxyWSHandler

  @doc "Validates :id + :port and upgrades the connection to a WebSocket."
  def upgrade(conn, %{"id" => id_str, "port" => port_str}) do
    with {run_id, ""} <- Integer.parse(id_str),
         {port, ""} <- Integer.parse(port_str),
         true <- port > 0 and port <= 65_535 do
      WebSockAdapter.upgrade(
        conn,
        ProxyWSHandler,
        %{run_id: run_id, target_port: port},
        timeout: 60_000
      )
    else
      _ ->
        conn |> put_status(400) |> json(%{error: "invalid params"})
    end
  end
end
