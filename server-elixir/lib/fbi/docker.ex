defmodule FBI.Docker do
  @moduledoc """
  Minimal Docker Engine API client over a unix socket. Only the operations
  needed by the active-run DELETE path are implemented: `kill/1`.
  """

  require Logger

  @spec kill(String.t()) :: :ok | {:error, term()}
  def kill(container_id) when is_binary(container_id) and container_id != "" do
    socket = Application.get_env(:fbi, :docker_socket_path, "/var/run/docker.sock")
    path = "/containers/#{container_id}/kill"

    case :gen_tcp.connect({:local, socket}, 0, [:binary, active: false]) do
      {:ok, conn} ->
        req = "POST #{path} HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n"
        :gen_tcp.send(conn, req)
        :gen_tcp.close(conn)
        :ok

      {:error, reason} ->
        Logger.warning("docker kill failed: #{inspect(reason)}")
        {:error, reason}
    end
  end

  def kill(_), do: :ok
end
