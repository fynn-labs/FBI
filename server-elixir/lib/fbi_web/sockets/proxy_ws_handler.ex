defmodule FBIWeb.Sockets.ProxyWSHandler do
  @moduledoc """
  Bridges an inbound WebSocket to a TCP socket on the container's bridge IP.

  Mirrors src/server/api/proxy.ts.

  ## Backpressure

  WS→TCP: `:gen_tcp.send/2` is synchronous (`send_timeout: infinity` default), so
  the WebSock `handle_in/2` callback blocks until the kernel socket buffer
  accepts the bytes. While blocked, no further inbound WS frames are processed —
  implicit process-level backpressure.

  TCP→WS: outbound socket is in `active: :once` mode. Each `{:tcp, _, data}`
  message is handled and the socket is re-armed; the next read won't fire until
  the WebSock has accepted the previous push. The transport layer below WebSock
  handles WS-side flow control.

  This is simpler than the TS reference (which manually pause/resumes), but
  equivalent in effect for the modest PTY/dev-server traffic this proxy carries.
  """

  @behaviour WebSock
  require Logger

  alias FBI.Runs.Queries

  @impl true
  def init(%{run_id: run_id, target_port: port}) do
    with {:ok, run} <- Queries.get(run_id),
         cid when is_binary(cid) and cid != "" <- run.container_id,
         {:ok, ip} <- container_bridge_ip(cid),
         {:ok, sock} <-
           :gen_tcp.connect(
             String.to_charlist(ip),
             port,
             [:binary, active: :once, packet: :raw],
             5_000
           ) do
      Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:state")
      {:ok, %{run_id: run_id, sock: sock}}
    else
      :not_found ->
        Logger.info("proxy WS: run #{inspect(run_id)} not found")
        {:stop, :run_not_found, %{run_id: run_id, sock: nil}}

      nil ->
        Logger.info("proxy WS: run #{inspect(run_id)} has no container_id")
        {:stop, :no_container, %{run_id: run_id, sock: nil}}

      "" ->
        Logger.info("proxy WS: run #{inspect(run_id)} has empty container_id")
        {:stop, :no_container, %{run_id: run_id, sock: nil}}

      {:error, reason} ->
        Logger.warning("proxy WS: tcp connect failed: #{inspect(reason)}")
        {:stop, {:tcp_connect_failed, reason}, %{run_id: run_id, sock: nil}}
    end
  end

  @impl true
  def handle_in({data, [opcode: :binary]}, %{sock: sock} = state) when not is_nil(sock) do
    case :gen_tcp.send(sock, data) do
      :ok -> {:ok, state}
      {:error, reason} -> {:stop, {:tcp_send_failed, reason}, state}
    end
  end

  # Drop text frames — protocol is binary-only.
  def handle_in({_, [opcode: :text]}, state), do: {:ok, state}

  def handle_in(_other, state), do: {:ok, state}

  @impl true
  def handle_info({:tcp, sock, data}, %{sock: sock} = state) do
    :inet.setopts(sock, active: :once)
    {:push, {:binary, data}, state}
  end

  def handle_info({:tcp_closed, sock}, %{sock: sock} = state) do
    {:stop, :tcp_closed, state}
  end

  def handle_info({:tcp_error, sock, _reason}, %{sock: sock} = state) do
    {:stop, :tcp_error, state}
  end

  # `FBI.Orchestrator.RunServer.publish_state/1` broadcasts `{:state, frame}`
  # on the `run:<id>:state` topic. Close on transition out of running/waiting.
  def handle_info({:state, %{state: s}}, state) when s not in ["running", "waiting"] do
    {:stop, :run_ended, state}
  end

  def handle_info({:state, _}, state), do: {:ok, state}

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{sock: sock}) when is_port(sock), do: :gen_tcp.close(sock)
  def terminate(_reason, _state), do: :ok

  defp container_bridge_ip(container_id) do
    case FBI.Docker.inspect_container(container_id) do
      {:ok, inspect} ->
        case FBI.Proxy.BridgeIp.pick(inspect) do
          ip when is_binary(ip) and ip != "" -> {:ok, ip}
          _ -> {:error, :no_bridge_ip}
        end

      err ->
        err
    end
  end
end
