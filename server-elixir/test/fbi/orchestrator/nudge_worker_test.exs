defmodule FBI.Orchestrator.NudgeWorkerTest do
  use ExUnit.Case, async: true
  alias FBI.Orchestrator.NudgeWorker

  test "schedule_second_ctrlc sends to socket after delay" do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(listener)

    {:ok, client} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false])
    {:ok, server_sock} = :gen_tcp.accept(listener)

    {:ok, worker} = NudgeWorker.start_link()
    NudgeWorker.schedule_second_ctrlc(worker, client, 10)

    assert {:ok, <<3>>} = :gen_tcp.recv(server_sock, 1, 200)

    :gen_tcp.close(client)
    :gen_tcp.close(server_sock)
    :gen_tcp.close(listener)
  end

  test "schedule_stop_container is a no-op safety check" do
    {:ok, worker} = NudgeWorker.start_link()
    # Just verify the cast doesn't crash; the actual Docker call will fail in
    # the test env (no daemon) but that's caught inside `stop_container`.
    NudgeWorker.schedule_stop_container(worker, "nonexistent", 10)
    Process.sleep(50)
    assert Process.alive?(worker)
  end
end
