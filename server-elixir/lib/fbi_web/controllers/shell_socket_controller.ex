defmodule FBIWeb.ShellSocketController do
  use FBIWeb, :controller

  def upgrade(conn, %{"id" => id}) do
    run_id = String.to_integer(id)
    WebSockAdapter.upgrade(conn, FBIWeb.Sockets.ShellWSHandler, %{run_id: run_id}, [])
  end
end
