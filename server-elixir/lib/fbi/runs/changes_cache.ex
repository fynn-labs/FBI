defmodule FBI.Runs.ChangesCache do
  @moduledoc """
  Per-run-id cache of the /api/runs/:id/changes payload with a 10-second TTL.

  This is an `Agent`: a tiny state-holding process whose API is just get/put.
  Matches the TS in-memory Map cache in `src/server/api/runs.ts`.
  """

  use Agent

  @ttl_ms 10_000

  @spec start_link(keyword()) :: {:ok, pid()}
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @spec get(integer()) :: {:hit, map()} | :miss
  def get(run_id) do
    now = System.monotonic_time(:millisecond)

    Agent.get(__MODULE__, fn state ->
      case Map.get(state, run_id) do
        %{value: v, expires_at: exp} when exp > now -> {:hit, v}
        _ -> :miss
      end
    end)
  end

  @spec put(integer(), map()) :: :ok
  def put(run_id, value) do
    now = System.monotonic_time(:millisecond)
    Agent.update(__MODULE__, &Map.put(&1, run_id, %{value: value, expires_at: now + @ttl_ms}))
  end

  @spec invalidate(integer()) :: :ok
  def invalidate(run_id) do
    Agent.update(__MODULE__, &Map.delete(&1, run_id))
  end
end
