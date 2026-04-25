defmodule FBI.Orchestrator.RunSupervisor do
  use DynamicSupervisor

  def start_link(opts) do
    DynamicSupervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end

  def start_run(run_id, mode, config) do
    spec = {FBI.Orchestrator.RunServer, {run_id, mode, config}}
    DynamicSupervisor.start_child(__MODULE__, spec)
  end

  def stop_run(run_id) do
    case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
      [{pid, _}] -> DynamicSupervisor.terminate_child(__MODULE__, pid)
      [] -> :ok
    end
  end
end
