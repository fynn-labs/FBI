defmodule FBI.Runs.ModelParamsTest do
  use ExUnit.Case, async: true
  alias FBI.Runs.ModelParams

  test "accepts unset values" do
    assert :ok = ModelParams.validate(%{})
    assert :ok = ModelParams.validate(%{model: nil, effort: nil, subagent_model: nil})
  end

  test "accepts known model + effort combos" do
    assert :ok = ModelParams.validate(%{model: "sonnet", effort: "high"})
    assert :ok = ModelParams.validate(%{model: "opus", effort: "xhigh"})
    assert :ok = ModelParams.validate(%{model: "haiku"})
    assert :ok = ModelParams.validate(%{subagent_model: "sonnet"})
  end

  test "rejects unknown model" do
    assert {:error, "invalid model: gpt"} = ModelParams.validate(%{model: "gpt"})
  end

  test "rejects unknown effort" do
    assert {:error, "invalid effort: blast"} = ModelParams.validate(%{effort: "blast"})
  end

  test "rejects unknown subagent_model" do
    assert {:error, "invalid subagent_model: gpt"} =
             ModelParams.validate(%{subagent_model: "gpt"})
  end

  test "rejects effort on haiku" do
    assert {:error, "effort is not supported on haiku"} =
             ModelParams.validate(%{model: "haiku", effort: "low"})
  end

  test "rejects xhigh on non-opus" do
    assert {:error, "xhigh effort is only supported on opus"} =
             ModelParams.validate(%{model: "sonnet", effort: "xhigh"})
  end
end
