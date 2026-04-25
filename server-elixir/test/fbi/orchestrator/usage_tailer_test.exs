defmodule FBI.Orchestrator.UsageTailerTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.UsageTailer

  test "emits usage event when jsonl line appended" do
    tmp = System.tmp_dir!()
    dir = Path.join(tmp, "usage-tailer-#{:rand.uniform(999_999)}")
    subdir = Path.join(dir, "proj")
    File.mkdir_p!(subdir)
    path = Path.join(subdir, "session.jsonl")
    test_pid = self()

    {:ok, pid} =
      UsageTailer.start_link(
        dir: dir,
        poll_ms: 50,
        on_usage: fn s -> send(test_pid, {:usage, s}) end,
        on_rate_limit: fn _ -> :ok end,
        on_error: fn _ -> :ok end
      )

    line =
      Jason.encode!(%{
        type: "assistant",
        message: %{
          usage: %{
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          }
        }
      })

    File.write!(path, line <> "\n")

    assert_receive {:usage, _snapshot}, 500
    UsageTailer.stop(pid)
  end
end
