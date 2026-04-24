defmodule FBIWeb.UsageSocketController do
  @moduledoc """
  Controller that handles the `/api/ws/usage` HTTP request and upgrades it to a
  WebSocket connection managed by `FBIWeb.Sockets.UsageWSHandler`.

  Phoenix routes the request here first because a `WebSock` callback module
  cannot double as a Phoenix controller target — the router calls `init(:action)`
  on the target module, which would collide with the `WebSock.init/1` callback
  the handler must define. Keeping the upgrade action in a plain controller
  isolates that routing concern from the socket callbacks.
  """

  use FBIWeb, :controller

  alias FBIWeb.Sockets.UsageWSHandler

  @doc "Upgrades the connection to a WebSocket handled by `UsageWSHandler`."
  def upgrade(conn, _params) do
    WebSockAdapter.upgrade(conn, UsageWSHandler, %{}, timeout: 60_000)
  end
end
