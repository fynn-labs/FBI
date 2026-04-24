defmodule FBI.Usage.PacingTest do
  use ExUnit.Case, async: true
  alias FBI.Usage.Pacing

  @known_bucket %{
    id: "five_hour",
    utilization: 0.5,
    reset_at: 5 * 3600 * 1000 + 1_000_000,
    window_started_at: 1_000_000
  }

  describe "derive_pacing/2" do
    test "returns :none zone when inside the warm-up window (<5% progress)" do
      bucket = %{@known_bucket | window_started_at: 999_999_500}
      now = 1_000_000_000
      # elapsed = 500ms, duration = 5h -> progress ~ tiny -> none
      assert %{delta: +0.0, zone: :none} = Pacing.derive_pacing(bucket, now)
    end

    test "returns :on_track when utilization matches expected progress" do
      # halfway through window, 50% utilized -> delta = 0
      now = @known_bucket.window_started_at + div(5 * 3600 * 1000, 2)
      bucket = %{@known_bucket | utilization: 0.5}
      %{delta: delta, zone: zone} = Pacing.derive_pacing(bucket, now)
      assert_in_delta delta, 0.0, 0.01
      assert zone == :on_track
    end

    test "returns :chill when utilization trails progress by more than 5%" do
      # halfway through, only 10% utilized -> delta ≈ -0.4 -> chill
      now = @known_bucket.window_started_at + div(5 * 3600 * 1000, 2)
      bucket = %{@known_bucket | utilization: 0.1}
      assert %{zone: :chill} = Pacing.derive_pacing(bucket, now)
    end

    test "returns :hot when utilization exceeds progress by >= 10%" do
      # 10% through, 50% utilized -> delta = +0.4 -> hot
      now = @known_bucket.window_started_at + div(5 * 3600 * 1000, 10)
      bucket = %{@known_bucket | utilization: 0.5}
      assert %{zone: :hot} = Pacing.derive_pacing(bucket, now)
    end

    test "returns :none when reset_at is nil" do
      bucket = %{@known_bucket | reset_at: nil}
      assert %{zone: :none, delta: +0.0} = Pacing.derive_pacing(bucket, 0)
    end

    test "derives window_start from reset_at for known buckets when window_started_at missing" do
      bucket = %{@known_bucket | window_started_at: nil}
      # derived start = reset_at - 5h -> halfway through now = reset_at - 2.5h
      now = bucket.reset_at - div(5 * 3600 * 1000, 2)
      %{delta: delta} = Pacing.derive_pacing(bucket, now)
      assert_in_delta delta, 0.0, 0.01
    end
  end
end
