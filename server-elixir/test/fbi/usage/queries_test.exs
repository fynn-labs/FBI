defmodule FBI.Usage.QueriesTest do
  use FBI.DataCase, async: true

  alias FBI.Usage.Queries
  alias FBI.Usage.RunUsageEvent

  # ---------------------------------------------------------------------------
  # RateLimitState
  # ---------------------------------------------------------------------------

  describe "get_state/0" do
    test "returns a struct with nil fields when no row exists" do
      state = Queries.get_state()
      assert state.id == 1
      assert is_nil(state.plan)
      assert is_nil(state.observed_at)
      assert is_nil(state.last_error)
      assert is_nil(state.last_error_at)
    end
  end

  describe "set_observed/1" do
    test "creates the singleton row with observed_at and clears errors" do
      Queries.set_observed(1_700_000_000_000)
      state = Queries.get_state()
      assert state.observed_at == 1_700_000_000_000
      assert is_nil(state.last_error)
      assert is_nil(state.last_error_at)
    end

    test "updates observed_at and clears previous error on second call" do
      Queries.set_error("rate_limit", 1_700_000_000_000)
      Queries.set_observed(1_700_000_001_000)

      state = Queries.get_state()
      assert state.observed_at == 1_700_000_001_000
      assert is_nil(state.last_error)
      assert is_nil(state.last_error_at)
    end
  end

  describe "set_error/2" do
    test "records error kind and timestamp" do
      Queries.set_error("rate_limit", 1_700_000_000_000)
      state = Queries.get_state()
      assert state.last_error == "rate_limit"
      assert state.last_error_at == 1_700_000_000_000
    end

    test "overwrites a previous error" do
      Queries.set_error("rate_limit", 1_700_000_000_000)
      Queries.set_error("auth_error", 1_700_000_001_000)
      state = Queries.get_state()
      assert state.last_error == "auth_error"
      assert state.last_error_at == 1_700_000_001_000
    end
  end

  describe "set_plan/1" do
    test "persists 'pro'" do
      Queries.set_plan("pro")
      assert Queries.get_state().plan == "pro"
    end

    test "persists 'max'" do
      Queries.set_plan("max")
      assert Queries.get_state().plan == "max"
    end

    test "persists 'team'" do
      Queries.set_plan("team")
      assert Queries.get_state().plan == "team"
    end

    test "overwrites previous plan" do
      Queries.set_plan("pro")
      Queries.set_plan("max")
      assert Queries.get_state().plan == "max"
    end
  end

  # ---------------------------------------------------------------------------
  # RateLimitBuckets
  # ---------------------------------------------------------------------------

  describe "list_buckets/0" do
    test "returns empty list when no rows" do
      assert Queries.list_buckets() == []
    end

    test "returns rows sorted by bucket_id ASC" do
      Queries.upsert_bucket(%{
        bucket_id: "tokens",
        utilization: 0.5,
        reset_at: nil,
        window_started_at: nil,
        observed_at: 1_700_000_000_000
      })

      Queries.upsert_bucket(%{
        bucket_id: "requests",
        utilization: 0.3,
        reset_at: nil,
        window_started_at: nil,
        observed_at: 1_700_000_000_000
      })

      ids = Queries.list_buckets() |> Enum.map(& &1.bucket_id)
      assert ids == ["requests", "tokens"]
    end
  end

  describe "upsert_bucket/1" do
    test "inserts a new bucket" do
      Queries.upsert_bucket(%{
        bucket_id: "requests",
        utilization: 0.4,
        reset_at: 1_700_003_600_000,
        window_started_at: 1_700_000_000_000,
        observed_at: 1_700_001_000_000
      })

      [bucket] = Queries.list_buckets()
      assert bucket.bucket_id == "requests"
      assert_in_delta bucket.utilization, 0.4, 0.0001
      assert bucket.reset_at == 1_700_003_600_000
      assert bucket.window_started_at == 1_700_000_000_000
      assert bucket.observed_at == 1_700_001_000_000
    end

    test "updates an existing bucket without touching notified columns" do
      Queries.upsert_bucket(%{
        bucket_id: "requests",
        utilization: 0.4,
        reset_at: 1_700_003_600_000,
        window_started_at: 1_700_000_000_000,
        observed_at: 1_700_001_000_000
      })

      Queries.mark_notified("requests", 80, 1_700_003_600_000)

      Queries.upsert_bucket(%{
        bucket_id: "requests",
        utilization: 0.9,
        reset_at: 1_700_007_200_000,
        window_started_at: 1_700_003_600_000,
        observed_at: 1_700_005_000_000
      })

      [bucket] = Queries.list_buckets()
      assert_in_delta bucket.utilization, 0.9, 0.0001
      assert bucket.reset_at == 1_700_007_200_000
      # notified columns must be preserved by the upsert
      assert bucket.last_notified_threshold == 80
      assert bucket.last_notified_reset_at == 1_700_003_600_000
    end
  end

  describe "replace_all/1" do
    test "upserts new buckets and deletes those not in the list" do
      Queries.upsert_bucket(%{
        bucket_id: "old",
        utilization: 0.1,
        reset_at: nil,
        window_started_at: nil,
        observed_at: 1_700_000_000_000
      })

      Queries.replace_all([
        %{
          bucket_id: "requests",
          utilization: 0.4,
          reset_at: nil,
          window_started_at: nil,
          observed_at: 1_700_001_000_000
        },
        %{
          bucket_id: "tokens",
          utilization: 0.6,
          reset_at: nil,
          window_started_at: nil,
          observed_at: 1_700_001_000_000
        }
      ])

      ids = Queries.list_buckets() |> Enum.map(& &1.bucket_id)
      assert ids == ["requests", "tokens"]
    end

    test "empty list deletes all rows" do
      Queries.upsert_bucket(%{
        bucket_id: "requests",
        utilization: 0.5,
        reset_at: nil,
        window_started_at: nil,
        observed_at: 1_700_000_000_000
      })

      Queries.replace_all([])
      assert Queries.list_buckets() == []
    end
  end

  describe "mark_notified/3" do
    test "records threshold and reset_at on the bucket" do
      Queries.upsert_bucket(%{
        bucket_id: "tokens",
        utilization: 0.8,
        reset_at: 1_700_003_600_000,
        window_started_at: nil,
        observed_at: 1_700_000_000_000
      })

      Queries.mark_notified("tokens", 75, 1_700_003_600_000)
      [bucket] = Queries.list_buckets()
      assert bucket.last_notified_threshold == 75
      assert bucket.last_notified_reset_at == 1_700_003_600_000
    end
  end

  describe "clear_notified_if_reset/0" do
    test "clears notified columns where reset_at differs from last_notified_reset_at" do
      Queries.upsert_bucket(%{
        bucket_id: "tokens",
        utilization: 0.8,
        reset_at: 1_700_007_200_000,
        window_started_at: nil,
        observed_at: 1_700_000_000_000
      })

      Queries.mark_notified("tokens", 75, 1_700_003_600_000)
      Queries.clear_notified_if_reset()

      [bucket] = Queries.list_buckets()
      assert is_nil(bucket.last_notified_threshold)
      assert is_nil(bucket.last_notified_reset_at)
    end

    test "preserves notified columns where reset_at matches last_notified_reset_at" do
      Queries.upsert_bucket(%{
        bucket_id: "requests",
        utilization: 0.5,
        reset_at: 1_700_003_600_000,
        window_started_at: nil,
        observed_at: 1_700_000_000_000
      })

      Queries.mark_notified("requests", 50, 1_700_003_600_000)
      Queries.clear_notified_if_reset()

      [bucket] = Queries.list_buckets()
      assert bucket.last_notified_threshold == 50
      assert bucket.last_notified_reset_at == 1_700_003_600_000
    end

    test "clears notified columns where reset_at is nil" do
      Queries.upsert_bucket(%{
        bucket_id: "tokens",
        utilization: 0.8,
        reset_at: nil,
        window_started_at: nil,
        observed_at: 1_700_000_000_000
      })

      Queries.mark_notified("tokens", 75, 1_700_003_600_000)
      Queries.clear_notified_if_reset()

      [bucket] = Queries.list_buckets()
      assert is_nil(bucket.last_notified_threshold)
      assert is_nil(bucket.last_notified_reset_at)
    end
  end

  # ---------------------------------------------------------------------------
  # RunUsageEvent / daily usage
  # ---------------------------------------------------------------------------

  describe "list_daily_usage/1" do
    # Day 1: 2023-11-14 => ts around 1_699_920_000_000
    # Day 2: 2023-11-15 => ts around 1_700_006_400_000
    @day1_ts 1_699_920_000_000
    @day2_ts 1_700_006_400_000

    defp insert_event(attrs) do
      Repo.insert!(%RunUsageEvent{
        run_id: attrs[:run_id] || 1,
        ts: attrs[:ts],
        model: attrs[:model] || "claude-opus-4-5",
        input_tokens: attrs[:input_tokens] || 0,
        output_tokens: attrs[:output_tokens] || 0,
        cache_read_tokens: attrs[:cache_read_tokens] || 0,
        cache_create_tokens: attrs[:cache_create_tokens] || 0
      })
    end

    test "aggregates events into daily rows with correct keys" do
      insert_event(%{ts: @day1_ts, run_id: 1, input_tokens: 100, output_tokens: 50})
      insert_event(%{ts: @day1_ts, run_id: 2, input_tokens: 200, output_tokens: 75})
      insert_event(%{ts: @day2_ts, run_id: 3, input_tokens: 300, output_tokens: 100})

      now = @day2_ts + 3_600_000
      rows = Queries.list_daily_usage(days: 30, now: now)

      assert length(rows) == 2
      [d1, d2] = rows

      assert Map.has_key?(d1, :date)
      assert Map.has_key?(d1, :tokens_total)
      assert Map.has_key?(d1, :tokens_input)
      assert Map.has_key?(d1, :tokens_output)
      assert Map.has_key?(d1, :tokens_cache_read)
      assert Map.has_key?(d1, :tokens_cache_create)
      assert Map.has_key?(d1, :run_count)

      assert d1.tokens_input == 300
      assert d1.tokens_output == 125
      assert d1.tokens_total == 425
      assert d1.run_count == 2

      assert d2.tokens_input == 300
      assert d2.tokens_output == 100
      assert d2.tokens_total == 400
      assert d2.run_count == 1
    end

    test "defaults to 14 days when days not provided" do
      now = @day2_ts + 3_600_000
      # Should not raise and should return empty list
      rows = Queries.list_daily_usage(now: now)
      assert rows == []
    end

    test "clamps days > 90 to 90" do
      insert_event(%{ts: @day1_ts, run_id: 1, input_tokens: 10, output_tokens: 5})
      now = @day1_ts + 100_000
      rows_90 = Queries.list_daily_usage(days: 90, now: now)
      rows_999 = Queries.list_daily_usage(days: 999, now: now)
      assert length(rows_90) == length(rows_999)
    end

    test "clamps days < 1 to 1" do
      insert_event(%{ts: @day1_ts, run_id: 1, input_tokens: 10, output_tokens: 5})
      now = @day1_ts + 100_000
      rows_1 = Queries.list_daily_usage(days: 1, now: now)
      rows_0 = Queries.list_daily_usage(days: 0, now: now)
      assert length(rows_1) == length(rows_0)
    end

    test "excludes events older than the window" do
      insert_event(%{ts: @day1_ts, run_id: 1, input_tokens: 100, output_tokens: 50})
      # now is just 1 day after day2, but day1 is 2 days before
      now = @day2_ts + 3_600_000
      rows = Queries.list_daily_usage(days: 1, now: now)
      # day1 is outside a 1-day window from now
      assert Enum.all?(rows, fn r -> r.date >= "2023-11-15" end)
    end
  end

  describe "get_run_breakdown/1" do
    test "returns per-model sums with truncated key names" do
      Repo.insert!(%RunUsageEvent{
        run_id: 10,
        ts: 1_700_000_000_000,
        model: "claude-opus-4-5",
        input_tokens: 100,
        output_tokens: 200,
        cache_read_tokens: 30,
        cache_create_tokens: 40
      })

      Repo.insert!(%RunUsageEvent{
        run_id: 10,
        ts: 1_700_000_001_000,
        model: "claude-opus-4-5",
        input_tokens: 50,
        output_tokens: 75,
        cache_read_tokens: 10,
        cache_create_tokens: 15
      })

      Repo.insert!(%RunUsageEvent{
        run_id: 10,
        ts: 1_700_000_002_000,
        model: "claude-haiku-3",
        input_tokens: 20,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_create_tokens: 0
      })

      rows = Queries.get_run_breakdown(10)
      assert length(rows) == 2

      haiku = Enum.find(rows, &(&1.model == "claude-haiku-3"))
      opus = Enum.find(rows, &(&1.model == "claude-opus-4-5"))

      # truncated key names must match the reference
      assert Map.has_key?(opus, :input)
      assert Map.has_key?(opus, :output)
      assert Map.has_key?(opus, :cache_read)
      assert Map.has_key?(opus, :cache_create)
      refute Map.has_key?(opus, :input_tokens)

      assert opus.input == 150
      assert opus.output == 275
      assert opus.cache_read == 40
      assert opus.cache_create == 55

      assert haiku.input == 20
      assert haiku.output == 10
      assert haiku.cache_read == 0
      assert haiku.cache_create == 0
    end

    test "returns empty list when run has no events" do
      assert Queries.get_run_breakdown(999) == []
    end

    test "only returns events for the requested run_id" do
      Repo.insert!(%RunUsageEvent{
        run_id: 1,
        ts: 1_700_000_000_000,
        model: "claude-opus-4-5",
        input_tokens: 100,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_create_tokens: 0
      })

      Repo.insert!(%RunUsageEvent{
        run_id: 2,
        ts: 1_700_000_000_000,
        model: "claude-opus-4-5",
        input_tokens: 999,
        output_tokens: 999,
        cache_read_tokens: 0,
        cache_create_tokens: 0
      })

      [row] = Queries.get_run_breakdown(1)
      assert row.input == 100
    end
  end
end
