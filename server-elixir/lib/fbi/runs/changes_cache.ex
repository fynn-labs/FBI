defmodule FBI.Runs.ChangesCache do
  @moduledoc """
  Per-run-id cache of the /api/runs/:id/changes payload with a 10-second TTL.

  This is an `Agent`: a tiny state-holding process whose API is just get/put.
  Matches the TS in-memory Map cache in `src/server/api/runs.ts`.

  `get/2` and `put/3` accept an optional `now_fn` (a `() -> integer` returning
  monotonic milliseconds) so tests can drive the clock without `Process.sleep`.
  Production callers use the no-arg/two-arg forms and get the real monotonic
  clock by default.
  """

  use Agent

  @ttl_ms 10_000

  @spec start_link(keyword()) :: {:ok, pid()}
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @spec get(integer(), (-> integer())) :: {:hit, map()} | :miss
  def get(run_id, now_fn \\ &monotonic_now/0) do
    now = now_fn.()

    Agent.get(__MODULE__, fn state ->
      case Map.get(state, run_id) do
        %{value: v, expires_at: exp} when exp > now -> {:hit, v}
        _ -> :miss
      end
    end)
  end

  @spec put(integer(), map(), (-> integer())) :: :ok
  def put(run_id, value, now_fn \\ &monotonic_now/0) do
    now = now_fn.()
    Agent.update(__MODULE__, &Map.put(&1, run_id, %{value: value, expires_at: now + @ttl_ms}))
  end

  @spec invalidate(integer()) :: :ok
  def invalidate(run_id) do
    Agent.update(__MODULE__, &Map.delete(&1, run_id))
  end

  defp monotonic_now, do: System.monotonic_time(:millisecond)
end
