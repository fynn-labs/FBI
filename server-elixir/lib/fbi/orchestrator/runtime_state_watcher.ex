defmodule FBI.Orchestrator.RuntimeStateWatcher do
  @moduledoc "Port of src/server/orchestrator/runtimeStateWatcher.ts."
  use GenServer

  defstruct [:waiting_path, :prompted_path, :poll_ms, :on_change, :last, :timer]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def stop(pid), do: GenServer.stop(pid)

  @impl true
  def init(opts) do
    state = %__MODULE__{
      waiting_path: Keyword.fetch!(opts, :waiting_path),
      prompted_path: Keyword.fetch!(opts, :prompted_path),
      poll_ms: Keyword.get(opts, :poll_ms, 500),
      on_change: Keyword.fetch!(opts, :on_change),
      last: nil,
      timer: nil
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
    waiting = File.exists?(state.waiting_path)
    prompted = File.exists?(state.prompted_path)
    derived = if waiting, do: :waiting, else: if(prompted, do: :running, else: :starting)

    if derived != state.last do
      state.on_change.(derived)
      %{state | last: derived}
    else
      state
    end
  end
end
