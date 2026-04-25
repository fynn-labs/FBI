defmodule FBI.Runs.ChangesCacheTest do
  use ExUnit.Case, async: false
  alias FBI.Runs.ChangesCache

  test "miss then hit" do
    ChangesCache.invalidate(42)
    assert :miss = ChangesCache.get(42)
    :ok = ChangesCache.put(42, %{x: 1})
    assert {:hit, %{x: 1}} = ChangesCache.get(42)
  end

  test "invalidate clears the cached entry" do
    :ok = ChangesCache.put(42, %{x: 1})
    :ok = ChangesCache.invalidate(42)
    assert :miss = ChangesCache.get(42)
  end

  test "entries expire after the 10s TTL" do
    ChangesCache.invalidate(7)

    fixed = fn -> 1_000 end
    :ok = ChangesCache.put(7, %{x: 1}, fixed)

    # Inside TTL window: hit.
    assert {:hit, %{x: 1}} = ChangesCache.get(7, fn -> 1_000 + 9_999 end)
    # Exactly at TTL boundary: expires_at == now, the guard is `exp > now`, so miss.
    assert :miss = ChangesCache.get(7, fn -> 1_000 + 10_000 end)
    # Past TTL: miss.
    assert :miss = ChangesCache.get(7, fn -> 1_000 + 10_001 end)
  end
end
