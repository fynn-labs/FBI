defmodule FBI.Usage.Queries do
  @moduledoc """
  Pure query functions over `FBI.Repo` for usage data.

  Covers three domains:

  - **Rate-limit state** — a singleton row (id = 1) that records the most
    recently observed global limit state, the current plan, and any error.
  - **Rate-limit buckets** — one row per named dimension (e.g. `"requests"`,
    `"tokens"`), including utilization and notification bookkeeping.
  - **Run usage events** — append-only token-consumption rows.  This module
    provides read/aggregate helpers; insertion is the responsibility of the
    agent-runtime writer.
  """

  import Ecto.Query

  alias FBI.Repo
  alias FBI.Usage.RateLimitBucket
  alias FBI.Usage.RateLimitState
  alias FBI.Usage.RunUsageEvent

  # ---------------------------------------------------------------------------
  # RateLimitState
  # ---------------------------------------------------------------------------

  @doc """
  Returns the singleton rate-limit state row.

  When no row exists a struct with `id: 1` and all other fields `nil` is
  returned instead.  This function never inserts a seed row; callers that need
  to guarantee the row exists should call one of the `set_*` functions first.
  """
  @spec get_state() :: RateLimitState.t()
  def get_state do
    Repo.get(RateLimitState, 1) ||
      %RateLimitState{id: 1, plan: nil, observed_at: nil, last_error: nil, last_error_at: nil}
  end

  @doc """
  Records a successful observation at `now` (Unix milliseconds).

  Clears `last_error` and `last_error_at` so stale error state is not
  reported after recovery.  Uses an upsert so the singleton row need not
  exist beforehand.
  """
  @spec set_observed(integer()) :: RateLimitState.t()
  def set_observed(now) do
    %RateLimitState{id: 1, observed_at: now, last_error: nil, last_error_at: nil}
    |> Repo.insert!(
      on_conflict: {:replace, [:observed_at, :last_error, :last_error_at]},
      conflict_target: :id
    )
  end

  @doc """
  Records an error of the given `kind` (e.g. `"rate_limit"`) at `now`
  (Unix milliseconds).

  Does not clear `observed_at`; a subsequent successful observation will
  overwrite the error fields.
  """
  @spec set_error(String.t(), integer()) :: RateLimitState.t()
  def set_error(kind, now) do
    %RateLimitState{id: 1, last_error: kind, last_error_at: now}
    |> Repo.insert!(
      on_conflict: {:replace, [:last_error, :last_error_at]},
      conflict_target: :id
    )
  end

  @doc """
  Persists the billing plan (`"pro"`, `"max"`, or `"team"`) to the singleton
  state row.
  """
  @spec set_plan(String.t()) :: RateLimitState.t()
  def set_plan(plan) do
    %RateLimitState{id: 1, plan: plan}
    |> Repo.insert!(
      on_conflict: {:replace, [:plan]},
      conflict_target: :id
    )
  end

  # ---------------------------------------------------------------------------
  # RateLimitBuckets
  # ---------------------------------------------------------------------------

  @doc """
  Returns all rate-limit bucket rows ordered by `bucket_id` ascending.
  """
  @spec list_buckets() :: [RateLimitBucket.t()]
  def list_buckets do
    RateLimitBucket
    |> order_by(:bucket_id)
    |> Repo.all()
  end

  @doc """
  Inserts or updates a single rate-limit bucket.

  On conflict the mutable observation columns are replaced: `utilization`,
  `reset_at`, `window_started_at`, and `observed_at`.  The notification
  bookkeeping columns (`last_notified_threshold`, `last_notified_reset_at`)
  are intentionally excluded from the update set so they survive a refresh.
  """
  @spec upsert_bucket(map()) :: RateLimitBucket.t()
  def upsert_bucket(bucket) do
    %RateLimitBucket{
      bucket_id: bucket.bucket_id,
      utilization: bucket.utilization,
      reset_at: bucket.reset_at,
      window_started_at: bucket.window_started_at,
      observed_at: bucket.observed_at
    }
    |> Repo.insert!(
      on_conflict: {:replace, [:utilization, :reset_at, :window_started_at, :observed_at]},
      conflict_target: :bucket_id
    )
  end

  @doc """
  Atomically replaces the full set of rate-limit buckets.

  Each bucket in `buckets` is upserted, then any rows whose `bucket_id` is
  not in `buckets` are deleted.  When `buckets` is empty the entire table is
  truncated.  The whole operation runs inside a single transaction.
  """
  @spec replace_all([map()]) :: :ok
  def replace_all(buckets) do
    Repo.transaction(fn ->
      for b <- buckets, do: upsert_bucket(b)

      ids = Enum.map(buckets, & &1.bucket_id)

      if ids == [] do
        Repo.delete_all(RateLimitBucket)
      else
        from(b in RateLimitBucket, where: b.bucket_id not in ^ids)
        |> Repo.delete_all()
      end
    end)

    :ok
  end

  @doc """
  Records that the user was notified about `bucket_id` at `threshold`
  (percent, integer) with the bucket's `reset_at` at the time of
  notification.
  """
  @spec mark_notified(String.t(), integer(), integer() | nil) :: {integer(), nil}
  def mark_notified(bucket_id, threshold, reset_at) do
    from(b in RateLimitBucket, where: b.bucket_id == ^bucket_id)
    |> Repo.update_all(
      set: [last_notified_threshold: threshold, last_notified_reset_at: reset_at]
    )
  end

  @doc """
  Resets notification bookkeeping for buckets whose window has rolled over.

  A row is cleared when `last_notified_reset_at` is not `NULL` **and** either
  `reset_at` is `NULL` or `reset_at` differs from `last_notified_reset_at`.
  Rows where the two values match are left untouched, meaning notifications
  are preserved for the same window.
  """
  @spec clear_notified_if_reset() :: {integer(), nil}
  def clear_notified_if_reset do
    from(b in RateLimitBucket,
      where:
        not is_nil(b.last_notified_reset_at) and
          (is_nil(b.reset_at) or b.reset_at != b.last_notified_reset_at)
    )
    |> Repo.update_all(set: [last_notified_threshold: nil, last_notified_reset_at: nil])
  end

  # ---------------------------------------------------------------------------
  # RunUsageEvent
  # ---------------------------------------------------------------------------

  @doc """
  Aggregates token usage by calendar day for the requested window.

  `opts` accepts:
  - `days` — number of days to look back; clamped to `[1, 90]`, defaults to `14`.
  - `now`  — current time as Unix milliseconds (required).

  Returns a list of maps with keys `date`, `tokens_total`, `tokens_input`,
  `tokens_output`, `tokens_cache_read`, `tokens_cache_create`, `run_count`,
  ordered by `date` ascending.  The date string uses the local timezone via
  SQLite's `'localtime'` modifier.
  """
  @spec list_daily_usage(keyword()) :: [map()]
  def list_daily_usage(opts) do
    days = opts |> Keyword.get(:days, 14) |> max(1) |> min(90)
    now = Keyword.fetch!(opts, :now)
    since_ms = now - days * 24 * 60 * 60 * 1000

    from(u in RunUsageEvent,
      where: u.ts >= ^since_ms,
      group_by: fragment("DATE(?/1000, 'unixepoch', 'localtime')", u.ts),
      order_by: fragment("DATE(?/1000, 'unixepoch', 'localtime')", u.ts),
      select: %{
        date: fragment("DATE(?/1000, 'unixepoch', 'localtime')", u.ts),
        tokens_total: sum(u.input_tokens + u.output_tokens),
        tokens_input: sum(u.input_tokens),
        tokens_output: sum(u.output_tokens),
        tokens_cache_read: sum(u.cache_read_tokens),
        tokens_cache_create: sum(u.cache_create_tokens),
        run_count: count(u.run_id, :distinct)
      }
    )
    |> Repo.all()
  end

  @doc """
  Returns per-model token sums for a single run.

  Keys in the returned maps are `model`, `input`, `output`, `cache_read`,
  `cache_create` (matching the abbreviated names used in the API response).
  Rows are ordered by `model` ascending.
  """
  @spec get_run_breakdown(integer()) :: [map()]
  def get_run_breakdown(run_id) do
    from(u in RunUsageEvent,
      where: u.run_id == ^run_id,
      group_by: u.model,
      order_by: u.model,
      select: %{
        model: u.model,
        input: sum(u.input_tokens),
        output: sum(u.output_tokens),
        cache_read: sum(u.cache_read_tokens),
        cache_create: sum(u.cache_create_tokens)
      }
    )
    |> Repo.all()
  end
end
