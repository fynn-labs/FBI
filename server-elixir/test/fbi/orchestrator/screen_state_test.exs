defmodule FBI.Orchestrator.ScreenStateTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.ScreenState

  setup do
    ScreenState.ensure_started()
    :ok
  end

  test "snapshot returns clear-screen prefix + fed bytes" do
    ScreenState.feed(99001, "hello world")
    snap = ScreenState.snapshot(99001)
    assert String.starts_with?(snap, "\e[2J\e[H")
    assert String.contains?(snap, "hello world")
    ScreenState.clear(99001)
  end

  test "snapshot for unknown run id returns clear-screen + empty" do
    snap = ScreenState.snapshot(99999)
    assert snap == "\e[2J\e[H"
  end

  test "ring buffer caps at 512 KB" do
    large = :binary.copy("x", 600 * 1024)
    ScreenState.feed(99002, large)
    snap = ScreenState.snapshot(99002)
    # Snapshot prefix + at most 512 KB
    assert byte_size(snap) <= 512 * 1024 + 10
    ScreenState.clear(99002)
  end
end
