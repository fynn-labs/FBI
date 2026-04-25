defmodule FBI.Orchestrator.ResultParserTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.ResultParser

  test "classify_result_json: completed" do
    raw = Jason.encode!(%{exit_code: 0, push_exit: 0, head_sha: "abc", branch: "main"})
    assert %{kind: :completed, exit_code: 0} = ResultParser.classify_result_json(raw)
  end

  test "classify_result_json: resume_failed" do
    raw = Jason.encode!(%{stage: "restore", error: "clone failed"})
    assert %{kind: :resume_failed, error: "clone failed"} = ResultParser.classify_result_json(raw)
  end

  test "classify_result_json: unparseable on bad json" do
    assert %{kind: :unparseable} = ResultParser.classify_result_json("not json")
  end

  test "parse_result_json: returns struct on valid input" do
    raw =
      Jason.encode!(%{
        exit_code: 1,
        push_exit: 0,
        head_sha: "def",
        branch: "feat",
        title: "Add thing"
      })

    assert {:ok, %{exit_code: 1, branch: "feat", title: "Add thing"}} =
             ResultParser.parse_result_json(raw)
  end

  test "parse_result_json: returns error on invalid" do
    assert :error = ResultParser.parse_result_json("{}")
  end
end
