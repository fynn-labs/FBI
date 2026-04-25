defmodule FBI.Orchestrator.ResumeScheduler do
  @moduledoc "Port of src/server/orchestrator/resumeScheduler.ts."
  use GenServer

  defstruct [:on_fire, timers: %{}]

  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name)
    gen_opts = if name, do: [name: name], else: []
    GenServer.start_link(__MODULE__, opts, gen_opts)
  end

  def schedule(pid, run_id, fire_at_ms) do
    GenServer.call(pid, {:schedule, run_id, fire_at_ms})
  end

  def cancel(pid, run_id) do
    GenServer.call(pid, {:cancel, run_id})
  end

  def fire_now(pid, run_id) do
    GenServer.call(pid, {:fire_now, run_id})
  end

  def rehydrate(pid, awaiting_runs) do
    GenServer.call(pid, {:rehydrate, awaiting_runs})
  end

  @impl true
  def init(opts) do
    {:ok, %__MODULE__{on_fire: Keyword.fetch!(opts, :on_fire)}}
  end

  @impl true
  def handle_call({:schedule, run_id, fire_at_ms}, _from, state) do
    state = cancel_timer(state, run_id)
    delay = max(0, fire_at_ms - System.os_time(:millisecond))
    ref = Process.send_after(self(), {:fire, run_id}, delay)
    {:reply, :ok, %{state | timers: Map.put(state.timers, run_id, ref)}}
  end

  def handle_call({:cancel, run_id}, _from, state) do
    {:reply, :ok, cancel_timer(state, run_id)}
  end

  def handle_call({:fire_now, run_id}, _from, state) do
    state = cancel_timer(state, run_id)
    Process.send_after(self(), {:fire, run_id}, 0)
    {:reply, :ok, state}
  end

  def handle_call({:rehydrate, awaiting_runs}, _from, state) do
    state =
      Enum.reduce(awaiting_runs, state, fn run, s ->
        s = cancel_timer(s, run.id)
        fire_at = run[:next_resume_at] || 0
        delay = max(0, fire_at - System.os_time(:millisecond))
        ref = Process.send_after(self(), {:fire, run.id}, delay)
        %{s | timers: Map.put(s.timers, run.id, ref)}
      end)

    {:reply, :ok, state}
  end

  @impl true
  def handle_info({:fire, run_id}, state) do
    state = %{state | timers: Map.delete(state.timers, run_id)}

    try do
      state.on_fire.(run_id)
    catch
      _, _ -> :ok
    end

    {:noreply, state}
  end

  defp cancel_timer(state, run_id) do
    case Map.pop(state.timers, run_id) do
      {nil, timers} ->
        %{state | timers: timers}

      {ref, timers} ->
        Process.cancel_timer(ref)
        %{state | timers: timers}
    end
  end
end
