defmodule FBI.Orchestrator.ContinueEligibilityTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.ContinueEligibility

  test "wrong_state for running run" do
    run = %{state: "running", claude_session_id: "abc", id: 1}
    assert {:error, :wrong_state, _} = ContinueEligibility.check(run, "/tmp")
  end

  test "no_session when session id nil" do
    run = %{state: "failed", claude_session_id: nil, id: 1}
    assert {:error, :no_session, _} = ContinueEligibility.check(run, "/tmp")
  end

  test "session_files_missing when no jsonl present" do
    run = %{state: "succeeded", claude_session_id: "abc", id: 999}
    assert {:error, :session_files_missing, _} = ContinueEligibility.check(run, "/tmp")
  end

  test "ok when jsonl exists" do
    tmp = System.tmp_dir!()
    run_id = 90001
    dir = Path.join([tmp, "runs_ce", to_string(run_id), "claude-projects", "some-proj"])
    File.mkdir_p!(dir)
    File.write!(Path.join(dir, "#{Ecto.UUID.generate()}.jsonl"), "{}")
    run = %{state: "failed", claude_session_id: "abc", id: run_id}
    assert :ok = ContinueEligibility.check(run, Path.join(tmp, "runs_ce"))
  end
end
