defmodule FBI.Usage.PollerTest do
  use FBI.DataCase, async: false

  alias FBI.Usage.Poller
  alias FBI.Usage.Queries

  @now 1_700_000_000_000

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp subscribe_usage, do: Phoenix.PubSub.subscribe(FBI.PubSub, "usage")

  defp simple_client(buckets, plan \\ "max") do
    fn
      :usage, _opts -> {:ok, buckets}
      :plan, _opts -> {:ok, plan}
    end
  end

  defp sample_buckets do
    [
      %{
        id: "five_hour",
        utilization: 0.50,
        reset_at: @now + 3_600_000,
        window_started_at: @now - 7_200_000
      }
    ]
  end

  # ---------------------------------------------------------------------------
  # poll_once/1 — happy path
  # ---------------------------------------------------------------------------

  describe "poll_once/1 success" do
    test "writes buckets to DB, sets observed_at, broadcasts snapshot" do
      subscribe_usage()

      client = simple_client(sample_buckets())

      Poller.poll_once(client: client, token: "tok", now: @now)

      # DB state
      state = Queries.get_state()
      assert state.observed_at == @now
      assert is_nil(state.last_error)

      buckets = Queries.list_buckets()
      assert length(buckets) == 1
      [b] = buckets
      assert b.bucket_id == "five_hour"
      assert b.utilization == 0.50

      # Broadcast
      assert_receive %{type: "snapshot", state: snap}
      assert snap.observed_at == @now
      assert is_nil(snap.last_error)
      assert length(snap.buckets) == 1
      assert is_map(snap.pacing)
    end

    test "pacing map is keyed by bucket id with stringified zone" do
      subscribe_usage()

      client = simple_client(sample_buckets())
      Poller.poll_once(client: client, token: "tok", now: @now)

      assert_receive %{type: "snapshot", state: snap}
      assert Map.has_key?(snap.pacing, "five_hour")
      verdict = snap.pacing["five_hour"]
      assert verdict.zone in ["chill", "on_track", "hot", "none"]
    end

    test "fetches plan and persists it" do
      client = simple_client(sample_buckets(), "pro")
      Poller.poll_once(client: client, token: "tok", now: @now)

      state = Queries.get_state()
      assert state.plan == "pro"
    end
  end

  # ---------------------------------------------------------------------------
  # poll_once/1 — error paths
  # ---------------------------------------------------------------------------

  describe "poll_once/1 error" do
    test ":expired sets last_error and broadcasts snapshot" do
      subscribe_usage()

      client = fn
        :usage, _opts -> {:error, :expired}
        :plan, _opts -> {:ok, nil}
      end

      Poller.poll_once(client: client, token: "tok", now: @now)

      state = Queries.get_state()
      assert state.last_error == "expired"
      assert state.last_error_at == @now

      assert_receive %{type: "snapshot", state: snap}
      assert snap.last_error == "expired"
      assert snap.last_error_at == @now
    end

    test ":rate_limited sets last_error = rate_limited" do
      subscribe_usage()

      client = fn
        :usage, _opts -> {:error, :rate_limited}
        :plan, _opts -> {:ok, nil}
      end

      Poller.poll_once(client: client, token: "tok", now: @now)

      state = Queries.get_state()
      assert state.last_error == "rate_limited"
      assert_receive %{type: "snapshot", state: snap}
      assert snap.last_error == "rate_limited"
    end

    test "missing token sets last_error = missing_credentials" do
      subscribe_usage()

      client = fn _kind, _opts -> raise "should not be called" end
      Poller.poll_once(client: client, token: nil, now: @now)

      state = Queries.get_state()
      assert state.last_error == "missing_credentials"
      assert state.last_error_at == @now

      assert_receive %{type: "snapshot", state: snap}
      assert snap.last_error == "missing_credentials"
    end
  end

  # ---------------------------------------------------------------------------
  # Threshold crossing
  # ---------------------------------------------------------------------------

  describe "threshold crossings" do
    test "bucket at 0.95 emits threshold_crossed: 90 and persists notification" do
      subscribe_usage()

      bucket = %{
        id: "five_hour",
        utilization: 0.95,
        reset_at: @now + 3_600_000,
        window_started_at: @now - 7_200_000
      }

      client = simple_client([bucket])
      Poller.poll_once(client: client, token: "tok", now: @now)

      assert_receive %{type: "threshold_crossed", bucket_id: "five_hour", threshold: 90}

      [b] = Queries.list_buckets()
      assert b.last_notified_threshold == 90
    end

    test "bucket at 0.80 emits threshold_crossed: 75 and not 90" do
      subscribe_usage()

      bucket = %{
        id: "five_hour",
        utilization: 0.80,
        reset_at: @now + 3_600_000,
        window_started_at: @now - 7_200_000
      }

      client = simple_client([bucket])
      Poller.poll_once(client: client, token: "tok", now: @now)

      assert_receive %{type: "threshold_crossed", bucket_id: "five_hour", threshold: 75}
      refute_receive %{type: "threshold_crossed", threshold: 90}

      [b] = Queries.list_buckets()
      assert b.last_notified_threshold == 75
    end

    test "does not re-emit if already notified at same threshold" do
      subscribe_usage()

      # First poll to set notified threshold to 90
      bucket = %{
        id: "five_hour",
        utilization: 0.95,
        reset_at: @now + 3_600_000,
        window_started_at: @now - 7_200_000
      }

      client = simple_client([bucket])
      Poller.poll_once(client: client, token: "tok", now: @now)
      assert_receive %{type: "threshold_crossed", threshold: 90}

      # Drain the snapshot message
      assert_receive %{type: "snapshot"}

      # Second poll with same utilization — should NOT re-emit threshold_crossed
      Poller.poll_once(client: client, token: "tok", now: @now + 1000)
      refute_receive %{type: "threshold_crossed"}
    end
  end

  # ---------------------------------------------------------------------------
  # Nudge gate
  # ---------------------------------------------------------------------------

  describe "nudge gate" do
    test "nudge is ignored when last attempt was too recent" do
      subscribe_usage()

      # Seed a recent observed_at — use real wall time so the gate fires correctly.
      real_now = System.system_time(:millisecond)
      recent_observed = real_now - 60_000
      Queries.set_observed(recent_observed)

      # Client that would fail if called
      client = fn _kind, _opts -> raise "client should not be called" end

      start_supervised!(
        {Poller,
         [
           client: client,
           token_fn: fn -> "tok" end,
           auto_tick: false,
           min_nudge_gap_ms: 5 * 60 * 1000
         ]}
      )

      Poller.nudge()

      # Give the GenServer time to process
      Process.sleep(100)

      # DB should be unchanged (still has the recent observed_at, no new poll)
      state = Queries.get_state()
      assert state.observed_at == recent_observed

      refute_receive %{type: "snapshot"}
    end

    test "nudge is allowed when last attempt was long ago" do
      subscribe_usage()

      # Seed an old observed_at — use real wall time so the gate fires correctly.
      real_now = System.system_time(:millisecond)
      Queries.set_observed(real_now - 10 * 60 * 1000)

      client = simple_client(sample_buckets())

      start_supervised!(
        {Poller,
         [
           client: client,
           token_fn: fn -> "tok" end,
           auto_tick: false,
           min_nudge_gap_ms: 5 * 60 * 1000
         ]}
      )

      Poller.nudge()

      assert_receive %{type: "snapshot"}, 2000
    end
  end

  # ---------------------------------------------------------------------------
  # snapshot/1
  # ---------------------------------------------------------------------------

  describe "snapshot/1" do
    test "returns correct shape with pacing as map keyed by bucket_id" do
      Queries.replace_all([
        %{
          bucket_id: "five_hour",
          utilization: 0.60,
          reset_at: @now + 3_600_000,
          window_started_at: @now - 7_200_000,
          observed_at: @now
        }
      ])

      Queries.set_observed(@now)
      Queries.set_plan("max")

      snap = Poller.snapshot(@now)

      assert snap.plan == "max"
      assert snap.observed_at == @now
      assert is_nil(snap.last_error)
      assert is_nil(snap.last_error_at)
      assert length(snap.buckets) == 1

      [b] = snap.buckets
      assert b.id == "five_hour"
      assert b.utilization == 0.60

      assert is_map(snap.pacing)
      assert Map.has_key?(snap.pacing, "five_hour")
      verdict = snap.pacing["five_hour"]
      assert verdict.zone in ["chill", "on_track", "hot", "none"]
      assert is_float(verdict.delta)
    end

    test "pacing zones are strings, not atoms" do
      Queries.replace_all([
        %{
          bucket_id: "weekly",
          utilization: 0.10,
          reset_at: @now + 5 * 24 * 3_600_000,
          window_started_at: @now - 2 * 24 * 3_600_000,
          observed_at: @now
        }
      ])

      snap = Poller.snapshot(@now)
      verdict = snap.pacing["weekly"]
      # zone must be a string, not an atom
      assert is_binary(verdict.zone)
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer lifecycle — missing token via token_fn
  # ---------------------------------------------------------------------------

  describe "GenServer — token_fn returns nil" do
    test "records missing_credentials error" do
      subscribe_usage()

      client = fn _kind, _opts -> raise "should not be called" end

      pid =
        start_supervised!(
          {Poller,
           [
             client: client,
             token_fn: fn -> nil end,
             auto_tick: false
           ]}
        )

      # Send a tick manually
      send(pid, :tick)

      assert_receive %{type: "snapshot", state: snap}, 2000
      assert snap.last_error == "missing_credentials"
    end
  end

  # ---------------------------------------------------------------------------
  # credentials_changed nudge
  # ---------------------------------------------------------------------------

  describe "credentials_changed" do
    test "triggers a poll when nudge gate allows it" do
      subscribe_usage()

      real_now = System.system_time(:millisecond)
      Queries.set_observed(real_now - 10 * 60 * 1000)

      client = simple_client(sample_buckets())

      start_supervised!(
        {Poller,
         [
           client: client,
           token_fn: fn -> "tok" end,
           auto_tick: false,
           min_nudge_gap_ms: 5 * 60 * 1000
         ]}
      )

      Phoenix.PubSub.broadcast(FBI.PubSub, "credentials", :credentials_changed)

      assert_receive %{type: "snapshot"}, 2000
    end
  end
end
