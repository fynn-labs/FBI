defmodule FBI.Orchestrator.MirrorStatusPoller do
  @moduledoc "Port of src/server/orchestrator/mirrorStatusPoller.ts."
  use GenServer

  defstruct [:path, :poll_ms, :on_change, :last, :timer]

  @valid_statuses ~w(ok pending failed)

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def stop(pid), do: GenServer.stop(pid)

  @impl true
  def init(opts) do
    state = %__MODULE__{
      path: Keyword.fetch!(opts, :path),
      poll_ms: Keyword.get(opts, :poll_ms, 1000),
      on_change: Keyword.fetch!(opts, :on_change),
      last: nil
    }

    state = read_once(state)
    timer = Process.send_after(self(), :tick, state.poll_ms)
    {:ok, %{state | timer: timer}}
  end

  @impl true
  def handle_info(:tick, state) do
    state = read_once(state)
    timer = Process.send_after(self(), :tick, state.poll_ms)
    {:noreply, %{state | timer: timer}}
  end

  @impl true
  def terminate(_reason, state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    :ok
  end

  defp read_once(state) do
    raw =
      case File.read(state.path) do
        {:ok, s} -> String.trim(s)
        _ -> ""
      end

    cur = if raw in @valid_statuses, do: raw, else: nil

    if cur != state.last do
      state.on_change.(cur)
      %{state | last: cur}
    else
      state
    end
  end
end
