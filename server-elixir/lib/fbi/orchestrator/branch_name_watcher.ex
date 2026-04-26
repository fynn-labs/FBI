defmodule FBI.Orchestrator.BranchNameWatcher do
  @moduledoc "Port of src/server/orchestrator/branchNameWatcher.ts."
  use GenServer

  # Mirrors VALID in branchNameWatcher.ts:3 — alphanumeric with optional
  # interior dots, slashes, hyphens, underscores. Not strictly kebab-case;
  # the "2–4 kebab-case words" guidance is preamble-only.
  @valid ~r/^[a-zA-Z0-9]([a-zA-Z0-9_.\/-]*[a-zA-Z0-9])?$/
  @max_len 100

  defstruct [:path, :poll_ms, :on_branch_name, :last_emitted, :timer]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def stop(pid), do: GenServer.stop(pid)

  @impl true
  def init(opts) do
    state = %__MODULE__{
      path: Keyword.fetch!(opts, :path),
      poll_ms: Keyword.get(opts, :poll_ms, 1000),
      on_branch_name: Keyword.fetch!(opts, :on_branch_name),
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

  defp read_once(%{path: path, on_branch_name: on_branch_name, last_emitted: last} = state) do
    case File.read(path) do
      {:ok, raw} ->
        trimmed = raw |> String.trim() |> String.slice(0, @max_len)

        if trimmed != "" and trimmed != last and Regex.match?(@valid, trimmed) do
          on_branch_name.(trimmed)
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
