defmodule FBI.Orchestrator.ResumeSchedulerTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.ResumeScheduler

  test "fires callback after delay" do
    test_pid = self()
    {:ok, pid} = ResumeScheduler.start_link(on_fire: fn id -> send(test_pid, {:fired, id}) end)
    now = System.os_time(:millisecond)
    ResumeScheduler.schedule(pid, 42, now + 100)
    assert_receive {:fired, 42}, 500
  end

  test "cancel prevents fire" do
    test_pid = self()
    {:ok, pid} = ResumeScheduler.start_link(on_fire: fn id -> send(test_pid, {:fired, id}) end)
    now = System.os_time(:millisecond)
    ResumeScheduler.schedule(pid, 99, now + 200)
    ResumeScheduler.cancel(pid, 99)
    refute_receive {:fired, 99}, 400
  end

  test "fire_now fires immediately" do
    test_pid = self()
    {:ok, pid} = ResumeScheduler.start_link(on_fire: fn id -> send(test_pid, {:fired, id}) end)
    now = System.os_time(:millisecond)
    ResumeScheduler.schedule(pid, 7, now + 60_000)
    ResumeScheduler.fire_now(pid, 7)
    assert_receive {:fired, 7}, 300
  end
end
