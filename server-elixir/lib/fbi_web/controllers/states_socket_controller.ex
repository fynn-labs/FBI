defmodule FBIWeb.StatesSocketController do
  use FBIWeb, :controller

  def upgrade(conn, _params) do
    WebSockAdapter.upgrade(conn, FBIWeb.Sockets.StatesWSHandler, %{}, [])
  end
end
