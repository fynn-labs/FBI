defmodule FBIWeb.Sockets.ShellWSHandler do
  @moduledoc """
  WebSock handler for /api/runs/:id/shell.

  Protocol:
  1. Client sends a JSON text frame: {"type":"hello","cols":N,"rows":M}
  2. Handler sends a JSON text frame: {"type":"snapshot","ansi":"<esc>[2J<esc>[H..."}
  3. Handler relays binary byte frames from PubSub as binary frames.
  4. Handler relays JSON event/state frames as text frames.
  5. Client may send {"type":"resize","cols":N,"rows":M} at any time.
  6. Client may send binary frames at any time (forwarded to container stdin).
  """

  @behaviour WebSock

  @impl true
  def init(%{run_id: run_id}) do
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:bytes")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:events")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:state")
    {:ok, %{run_id: run_id, greeted: false}}
  end

  # Incoming text frames: JSON control messages from the client
  @impl true
  def handle_in({text, [opcode: :text]}, %{run_id: run_id, greeted: false} = state) do
    case Jason.decode(text) do
      {:ok, %{"type" => "hello", "cols" => cols, "rows" => rows}} ->
        FBI.Orchestrator.resize(run_id, cols, rows)
        reply = Jason.encode!(%{type: "snapshot", ansi: build_snapshot(run_id)})
        {:push, {:text, reply}, %{state | greeted: true}}

      _ ->
        {:ok, state}
    end
  end

  # Build the initial-connect snapshot from the run's persisted log file
  # rather than the in-memory ring buffer. The log is the source of truth and
  # never evicts content, so refresh produces the same screen as the live
  # stream did. Cap the tail at 2 MiB to keep xterm.js replay snappy and the
  # WS frame small; older bytes scroll out of xterm's own scrollback the same
  # way they would have during live streaming.
  @snapshot_cap 2 * 1024 * 1024
  @clear_screen "\e[2J\e[H"

  defp build_snapshot(run_id) do
    case FBI.Runs.Queries.get(run_id) do
      {:ok, %{log_path: path}} when is_binary(path) ->
        size = FBI.Runs.LogStore.byte_size(path)

        tail =
          if size > @snapshot_cap do
            FBI.Runs.LogStore.read_range(path, size - @snapshot_cap, size - 1)
          else
            FBI.Runs.LogStore.read_all(path)
          end

        @clear_screen <> tail

      _ ->
        @clear_screen
    end
  end

  def handle_in({text, [opcode: :text]}, %{run_id: run_id} = state) do
    case Jason.decode(text) do
      {:ok, %{"type" => "resize", "cols" => cols, "rows" => rows}} ->
        FBI.Orchestrator.resize(run_id, cols, rows)
        {:ok, state}

      _ ->
        {:ok, state}
    end
  end

  # Incoming binary frames: forward to container stdin
  def handle_in({data, [opcode: :binary]}, %{run_id: run_id} = state) do
    FBI.Orchestrator.write_stdin(run_id, data)
    {:ok, state}
  end

  # PubSub: binary terminal bytes — forward as binary frame
  @impl true
  def handle_info({:bytes, chunk}, state) do
    {:push, {:binary, chunk}, state}
  end

  # PubSub: JSON event or state maps — forward as text frame
  def handle_info({:event, map}, state) do
    {:push, {:text, Jason.encode!(map)}, state}
  end

  def handle_info({:state, map}, state) do
    {:push, {:text, Jason.encode!(map)}, state}
  end

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, _state), do: :ok
end
