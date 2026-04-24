defmodule FBIWeb.ProxyRouter do
  @moduledoc """
  Dispatcher for unmatched routes. Inspects the request to decide whether it's
  a WebSocket upgrade or a regular HTTP request, then hands off to the
  corresponding proxy module.

  Reads the upstream URL from `Application.get_env(:fbi, :proxy_target)`.
  """

  import Plug.Conn

  alias FBIWeb.Proxy

  def init(opts), do: opts

  def call(conn, _opts) do
    target = Application.fetch_env!(:fbi, :proxy_target)

    if websocket_upgrade?(conn) do
      Proxy.WebSocket.upgrade(conn, target: target)
    else
      Proxy.Http.call(conn, target: target)
    end
  end

  # Phoenix's `match :*` route invokes the module/action like a controller —
  # `:dispatch` is the action keyword we register. Just delegate to call/2.
  def dispatch(conn, opts), do: call(conn, opts)

  defp websocket_upgrade?(conn) do
    case get_req_header(conn, "upgrade") do
      [v | _] -> String.downcase(v) == "websocket"
      _ -> false
    end
  end
end
