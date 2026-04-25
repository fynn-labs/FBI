defmodule FBI.Orchestrator.TitleWatcherTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.TitleWatcher

  test "fires callback when file appears with title" do
    tmp = System.tmp_dir!()
    path = Path.join(tmp, "session-name-#{:rand.uniform(999_999)}")
    test_pid = self()

    {:ok, pid} =
      TitleWatcher.start_link(
        path: path,
        poll_ms: 50,
        on_title: fn t -> send(test_pid, {:title, t}) end
      )

    File.write!(path, "  My New Title  ")
    assert_receive {:title, "My New Title"}, 500
    TitleWatcher.stop(pid)
  end

  test "does not fire twice for same title" do
    tmp = System.tmp_dir!()
    path = Path.join(tmp, "session-name-#{:rand.uniform(999_999)}")
    test_pid = self()

    File.write!(path, "Same Title")

    {:ok, pid} =
      TitleWatcher.start_link(
        path: path,
        poll_ms: 50,
        on_title: fn t -> send(test_pid, {:title, t}) end
      )

    assert_receive {:title, "Same Title"}, 300
    refute_receive {:title, _}, 200
    TitleWatcher.stop(pid)
  end
end
