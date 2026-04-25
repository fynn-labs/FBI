defmodule FBI.Orchestrator.ResumeDetectorTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.ResumeDetector

  test "classify: pipe epoch in log" do
    log = "some text\nClaude usage limit reached|#{:os.system_time(:millisecond) + 300_000}\nmore"
    result = ResumeDetector.classify(log, nil, :os.system_time(:millisecond))
    assert result.kind == :rate_limit
    assert is_integer(result.reset_at)
  end

  test "classify: lenient pattern with no state gives fallback clamp" do
    log = "You hit your usage limit today"
    result = ResumeDetector.classify(log, nil, :os.system_time(:millisecond))
    assert result.kind == :rate_limit
    assert result.source == :fallback_clamp
  end

  test "classify: no signal returns other" do
    result = ResumeDetector.classify("hello world", nil, :os.system_time(:millisecond))
    assert result.kind == :other
  end

  test "contains_limit_signal: true for pipe epoch" do
    assert ResumeDetector.contains_limit_signal("Claude usage limit reached|12345")
  end

  test "contains_limit_signal: false for plain text" do
    refute ResumeDetector.contains_limit_signal("everything is fine")
  end

  test "strip_ansi removes CSI sequences" do
    assert ResumeDetector.strip_ansi("\e[0mhello\e[1;32mworld") == "helloworld"
  end
end
