defmodule FBI.Orchestrator.RunServerMockTest do
  use ExUnit.Case, async: false

  test "Application config defaults are sensible" do
    # Verify the runtime.exs config keys exist and have expected types.
    Application.put_env(:fbi, :quantico_enabled, false)
    Application.put_env(:fbi, :quantico_binary_path, "/no/such/path/quantico")
    Application.put_env(:fbi, :limit_monitor_idle_ms, 15_000)
    Application.put_env(:fbi, :limit_monitor_warmup_ms, 60_000)

    assert Application.get_env(:fbi, :quantico_enabled) == false
    assert Application.get_env(:fbi, :quantico_binary_path) == "/no/such/path/quantico"
    assert Application.get_env(:fbi, :limit_monitor_idle_ms) == 15_000
  end
end
