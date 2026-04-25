defmodule FBI.Orchestrator.HistoryOpTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.HistoryOp

  test "parse_result: complete when ok+sha" do
    stdout = ~s({"ok":true,"sha":"abc123"})
    assert {:complete, "abc123"} = HistoryOp.parse_result(stdout, 0)
  end

  test "parse_result: conflict-detected" do
    stdout = ~s({"reason":"conflict","message":"merge conflict in foo.ex"})
    assert {:conflict_detected, "merge conflict in foo.ex"} = HistoryOp.parse_result(stdout, 1)
  end

  test "parse_result: gh-error on empty output" do
    assert {:gh_error, _} = HistoryOp.parse_result("", 1)
  end

  test "build_env: merge op" do
    env = HistoryOp.build_env(1, "feat/x", "main", %{op: "merge", strategy: "merge"}, nil)
    assert env["FBI_OP"] == "merge"
    assert env["FBI_STRATEGY"] == "merge"
  end

  test "build_env: squash-local op" do
    env =
      HistoryOp.build_env(1, "feat/x", "main", %{op: "squash-local", subject: "My commit"}, nil)

    assert env["FBI_SUBJECT"] == "My commit"
  end
end
