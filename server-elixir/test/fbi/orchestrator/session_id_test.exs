defmodule FBI.Orchestrator.SessionIdTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.SessionId

  test "scan_session_id returns nil when dir missing" do
    assert nil == SessionId.scan_session_id("/nonexistent_fbi_session_test")
  end

  test "scan_session_id finds uuid.jsonl" do
    tmp = System.tmp_dir!()
    uuid = Ecto.UUID.generate()
    dir = Path.join([tmp, "scan_test_#{:rand.uniform(999_999)}", "subdir"])
    File.mkdir_p!(dir)
    File.write!(Path.join(dir, "#{uuid}.jsonl"), "{}")
    result = SessionId.scan_session_id(Path.join(tmp, Path.dirname(dir) |> Path.basename()))
    assert result == uuid
  end
end
