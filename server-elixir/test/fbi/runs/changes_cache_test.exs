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
end
