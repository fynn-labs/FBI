defmodule FBI.Usage.SchemasTest do
  use FBI.DataCase, async: true

  alias FBI.Usage.RateLimitState
  alias FBI.Usage.RateLimitBucket
  alias FBI.Usage.RunUsageEvent

  describe "RateLimitState changeset" do
    test "requires id" do
      changeset = RateLimitState.changeset(%RateLimitState{}, %{})
      assert %{id: ["can't be blank"]} = errors_on(changeset)
    end

    test "accepts id = 1" do
      changeset = RateLimitState.changeset(%RateLimitState{}, %{id: 1, plan: "free"})
      assert changeset.valid?
    end

    test "rejects id other than 1" do
      changeset = RateLimitState.changeset(%RateLimitState{}, %{id: 2})
      assert %{id: [_]} = errors_on(changeset)
    end
  end

  describe "RateLimitBucket changeset" do
    test "rejects utilization outside [0.0, 1.0]" do
      changeset =
        RateLimitBucket.changeset(%RateLimitBucket{}, %{
          bucket_id: "tok",
          utilization: 1.5,
          observed_at: 1_000
        })

      assert %{utilization: [_]} = errors_on(changeset)
    end

    test "accepts utilization at boundary values" do
      for u <- [0.0, 0.5, 1.0] do
        changeset =
          RateLimitBucket.changeset(%RateLimitBucket{}, %{
            bucket_id: "tok",
            utilization: u,
            observed_at: 1_000
          })

        assert changeset.valid?, "expected valid for utilization=#{u}"
      end
    end
  end

  describe "RateLimitState round-trip" do
    test "insert and fetch by id = 1" do
      {:ok, state} =
        %RateLimitState{}
        |> RateLimitState.changeset(%{id: 1, plan: "pro", observed_at: 1_234_567})
        |> Repo.insert()

      fetched = Repo.get!(RateLimitState, 1)
      assert fetched.id == 1
      assert fetched.plan == state.plan
      assert fetched.observed_at == state.observed_at
    end
  end

  describe "RateLimitBucket round-trip" do
    test "insert and fetch by bucket_id" do
      {:ok, bucket} =
        %RateLimitBucket{}
        |> RateLimitBucket.changeset(%{
          bucket_id: "requests",
          utilization: 0.42,
          observed_at: 9_999
        })
        |> Repo.insert()

      fetched = Repo.get!(RateLimitBucket, "requests")
      assert fetched.bucket_id == bucket.bucket_id
      assert_in_delta fetched.utilization, 0.42, 0.0001
      assert fetched.observed_at == 9_999
    end
  end

  describe "RunUsageEvent round-trip" do
    test "insert a full row and read back run_id and ts" do
      {:ok, event} =
        Repo.insert(%RunUsageEvent{
          run_id: 42,
          ts: 1_700_000_000,
          model: "claude-opus-4-5",
          input_tokens: 100,
          output_tokens: 200,
          cache_read_tokens: 10,
          cache_create_tokens: 5,
          rl_requests_remaining: 900,
          rl_requests_limit: 1000,
          rl_tokens_remaining: 800_000,
          rl_tokens_limit: 1_000_000,
          rl_reset_at: 1_700_003_600
        })

      fetched = Repo.get!(RunUsageEvent, event.id)
      assert fetched.run_id == 42
      assert fetched.ts == 1_700_000_000
      assert fetched.model == "claude-opus-4-5"
      assert fetched.input_tokens == 100
      assert fetched.output_tokens == 200
      assert fetched.rl_reset_at == 1_700_003_600
    end
  end
end
