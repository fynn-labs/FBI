defmodule FBI.TerminalTest do
  use ExUnit.Case, async: true

  test "new/2 returns a handle and snapshot/1 round-trips dims" do
    h = FBI.Terminal.new(80, 24)
    snap = FBI.Terminal.snapshot(h)
    assert %FBI.Terminal.Snapshot{cols: 80, rows: 24, byte_offset: 0} = snap
    assert is_binary(snap.ansi)
  end

  test "feed/2 advances byte_offset" do
    h = FBI.Terminal.new(80, 24)
    assert :ok == FBI.Terminal.feed(h, "hello")
    snap = FBI.Terminal.snapshot(h)
    assert snap.byte_offset == 5
  end

  test "resize/3 changes reported dims" do
    h = FBI.Terminal.new(80, 24)
    assert :ok == FBI.Terminal.resize(h, 120, 40)
    snap = FBI.Terminal.snapshot(h)
    assert {snap.cols, snap.rows} == {120, 40}
  end

  test "snapshot_at/2 returns a ModePrefix at a historical offset" do
    h = FBI.Terminal.new(80, 24)
    FBI.Terminal.feed(h, "\e[?1049h")  # enter alt screen, 8 bytes
    # snapshot_at(8) = modes AFTER byte 8, i.e. after the full sequence
    pref = FBI.Terminal.snapshot_at(h, 8)
    assert %FBI.Terminal.ModePrefix{ansi: ansi} = pref
    # The mode prefix should put a fresh xterm into alt screen.
    assert String.contains?(ansi, "\e[?1049h")
  end

  test "feed/2 with binary preserves bytes (large input)" do
    h = FBI.Terminal.new(80, 24)
    big = :crypto.strong_rand_bytes(10_000)
    # ANSI parser may interpret these bytes weirdly but must not crash.
    assert :ok == FBI.Terminal.feed(h, big)
    snap = FBI.Terminal.snapshot(h)
    assert snap.byte_offset == 10_000
  end
end
