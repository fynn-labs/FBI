defmodule FBI.Orchestrator.TitleWatcher do
  @moduledoc "Port of src/server/orchestrator/titleWatcher.ts."
  use GenServer

  defstruct [:path, :poll_ms, :on_title, :last_emitted, :timer]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def stop(pid), do: GenServer.stop(pid)

  @impl true
  def init(opts) do
    state = %__MODULE__{
      path: Keyword.fetch!(opts, :path),
      poll_ms: Keyword.get(opts, :poll_ms, 1000),
      on_title: Keyword.fetch!(opts, :on_title),
      last_emitted: nil,
      timer: nil
    }

    {:ok, schedule(state)}
  end

  @impl true
  def handle_info(:tick, state) do
    state = read_once(state)
    {:noreply, schedule(state)}
  end

  @impl true
  def terminate(_reason, state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    read_once(state)
    :ok
  end

  defp schedule(state) do
    timer = Process.send_after(self(), :tick, state.poll_ms)
    %{state | timer: timer}
  end

  defp read_once(%{path: path, on_title: on_title, last_emitted: last} = state) do
    case File.read(path) do
      {:ok, raw} ->
        trimmed = raw |> String.trim() |> String.slice(0, 80)

        if trimmed != "" and trimmed != last do
          on_title.(trimmed)
          %{state | last_emitted: trimmed}
        else
          state
        end

      {:error, :enoent} ->
        state

      _ ->
        state
    end
  end
end
