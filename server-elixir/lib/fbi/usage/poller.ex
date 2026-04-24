defmodule FBI.Usage.Poller do
  @moduledoc """
  GenServer that polls the Anthropic OAuth API on a 5-minute cadence and
  broadcasts usage snapshots on the `"usage"` PubSub topic.

  ## Why a GenServer?

  The poller needs to hold three pieces of mutable state between polls:

  - The timer reference for the recurring `:tick` message, so it can be
    cancelled on shutdown without leaving stale timers.
  - The injected `client` function (used by tests to avoid real HTTP calls).
  - A `plan_fetched` boolean so the plan endpoint is hit only once per
    process lifetime (plan data rarely changes, and the endpoint costs an
    extra round-trip).

  ## Nudge semantics

  Any subsystem can call `nudge/0` to ask the poller to run a poll
  immediately.  The nudge is silently dropped when the last poll attempt
  (success *or* failure) was less than `min_nudge_gap_ms` milliseconds ago.

  Critically, the gate is enforced via the *persisted* `observed_at` /
  `last_error_at` columns in the database — not in-process state.  This
  means the rate-limit gate survives server restarts: if the server was
  restarted 30 seconds after a poll, a nudge fired at startup will be
  correctly suppressed even though the new process has no in-memory history.

  ## Test seam — `:client` option

  Pass a two-arity function as `:client` to avoid real HTTP calls in tests:

      client = fn
        :usage, _opts -> {:ok, [...]}
        :plan, _opts -> {:ok, "max"}
      end

      start_supervised!({Poller, [client: client, token_fn: fn -> "tok" end, auto_tick: false]})

  ## Supervision

  Started under `FBI.Application` as part of the usage supervision tree.
  See `FBI.Application` for the full child spec.
  """

  use GenServer
  require Logger

  alias FBI.Usage.Pacing
  alias FBI.Usage.Queries

  @default_interval_ms 5 * 60 * 1000
  @default_min_nudge_gap_ms 5 * 60 * 1000

  # ---------------------------------------------------------------------------
  # Types
  # ---------------------------------------------------------------------------

  @type client_fn :: (:usage | :plan, keyword() -> {:ok, term()} | {:error, atom()})

  @type opt ::
          {:client, client_fn()}
          | {:token_fn, (-> String.t() | nil)}
          | {:interval_ms, pos_integer()}
          | {:min_nudge_gap_ms, pos_integer()}
          | {:auto_tick, boolean()}
          | {:name, GenServer.name() | nil}

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Starts the poller GenServer.

  ## Options

    * `:client` — injectable two-arity function `(kind, opts) -> result`.
      Defaults to the production HTTP client backed by `FBI.Usage.OAuthClient`.
    * `:token_fn` — zero-arity function returning the current OAuth token string,
      or `nil` when credentials are unavailable. Required in production.
    * `:interval_ms` — milliseconds between scheduled polls. Defaults to
      `#{@default_interval_ms}` (5 minutes).
    * `:min_nudge_gap_ms` — minimum gap between any two polls triggered via
      `nudge/0` or a `credentials_changed` event. Defaults to
      `#{@default_min_nudge_gap_ms}` (5 minutes).
    * `:auto_tick` — when `true` (default) the poller schedules its first
      `:tick` on init based on persisted state. Set `false` in tests to keep
      the tick loop quiet.
    * `:name` — registered name for the GenServer. Defaults to `__MODULE__`.
      Pass `nil` to skip registration (useful when running multiple instances
      in tests).
  """
  @spec start_link([opt()]) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)

    gen_opts =
      if name do
        [name: name]
      else
        []
      end

    GenServer.start_link(__MODULE__, opts, gen_opts)
  end

  @doc """
  Synchronously performs a single poll cycle and returns `:ok` when complete.

  This function is the shared work-horse used both by the tick loop and
  directly in tests.  It accepts the following keyword options:

    * `:client` (required) — two-arity client function.
    * `:token` (required) — OAuth token string, or `nil` to simulate missing
      credentials.
    * `:now` (optional) — current time as Unix milliseconds. Defaults to
      `System.system_time(:millisecond)`.
  """
  @spec poll_once(keyword()) :: :ok
  def poll_once(opts) do
    client = Keyword.fetch!(opts, :client)
    token = Keyword.get(opts, :token)
    now = Keyword.get(opts, :now, System.system_time(:millisecond))

    do_poll_cycle(client, token, now)
  end

  @doc """
  Asks the poller to run a poll immediately, subject to the nudge-gap gate.

  The request is silently ignored when the last poll attempt (success or
  failure) was within `min_nudge_gap_ms` milliseconds. The gate is evaluated
  against the *persisted* database timestamps so it survives restarts.
  """
  @spec nudge() :: :ok
  def nudge do
    GenServer.cast(__MODULE__, :nudge)
  end

  @doc """
  Returns the current usage snapshot derived from live database state.

  Used by the REST controller and the WebSocket handler to serve the initial
  state to connecting clients.

  The returned map matches the `UsageState` wire shape:

      %{
        plan: "max" | "pro" | "team" | nil,
        observed_at: integer() | nil,
        last_error: String.t() | nil,
        last_error_at: integer() | nil,
        buckets: [%{id: String.t(), utilization: float(), reset_at: integer() | nil,
                    window_started_at: integer() | nil}],
        pacing: %{String.t() => %{delta: float(), zone: String.t()}}
      }
  """
  @spec snapshot(integer() | nil) :: map()
  def snapshot(now \\ nil) do
    t = now || System.system_time(:millisecond)
    state = Queries.get_state()
    buckets = Queries.list_buckets() |> Enum.map(&bucket_to_wire/1)

    pacing =
      for b <- buckets, into: %{} do
        verdict = Pacing.derive_pacing(b, t)
        {b.id, %{delta: verdict.delta, zone: verdict_to_wire(verdict.zone)}}
      end

    %{
      plan: state.plan,
      observed_at: state.observed_at,
      last_error: state.last_error,
      last_error_at: state.last_error_at,
      buckets: buckets,
      pacing: pacing
    }
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(opts) do
    # Subscribe so credential file changes can trigger a nudge.
    Phoenix.PubSub.subscribe(FBI.PubSub, "credentials")

    interval_ms = Keyword.get(opts, :interval_ms, @default_interval_ms)
    min_nudge_gap_ms = Keyword.get(opts, :min_nudge_gap_ms, @default_min_nudge_gap_ms)
    auto_tick = Keyword.get(opts, :auto_tick, true)

    client = Keyword.get(opts, :client, &default_client/2)
    token_fn = Keyword.get(opts, :token_fn, fn -> nil end)

    state = %{
      client: client,
      token_fn: token_fn,
      interval_ms: interval_ms,
      min_nudge_gap_ms: min_nudge_gap_ms,
      plan_fetched: false,
      tick_ref: nil
    }

    state =
      if auto_tick do
        ref = schedule_first_tick(interval_ms)
        %{state | tick_ref: ref}
      else
        state
      end

    {:ok, state}
  end

  @impl true
  def handle_info(:tick, state) do
    now = System.system_time(:millisecond)
    token = state.token_fn.()

    new_plan_fetched = do_poll_cycle_stateful(state.client, token, now, state.plan_fetched)

    # Schedule the next tick unconditionally after each tick fires.
    ref = Process.send_after(self(), :tick, state.interval_ms)

    {:noreply, %{state | tick_ref: ref, plan_fetched: new_plan_fetched}}
  end

  # Credential file changed — treat like a nudge.
  @impl true
  def handle_info(:credentials_changed, state) do
    state = maybe_nudge(state)
    {:noreply, state}
  end

  # Ignore any other info messages (e.g. stale timers after stop).
  @impl true
  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def handle_cast(:nudge, state) do
    state = maybe_nudge(state)
    {:noreply, state}
  end

  # ---------------------------------------------------------------------------
  # Private — nudge logic
  # ---------------------------------------------------------------------------

  # Applies the persisted-state rate-limit gate, then polls if allowed.
  # Returns updated state (plan_fetched may change).
  defp maybe_nudge(state) do
    now = System.system_time(:millisecond)

    if nudge_allowed?(now, state.min_nudge_gap_ms) do
      new_plan_fetched =
        do_poll_cycle_stateful(state.client, state.token_fn.(), now, state.plan_fetched)

      %{state | plan_fetched: new_plan_fetched}
    else
      state
    end
  end

  # The gate is evaluated against the DB so it survives restarts.
  # last_attempt = max(observed_at || 0, last_error_at || 0)
  defp nudge_allowed?(now, min_gap_ms) do
    db_state = Queries.get_state()
    last_attempt = max(db_state.observed_at || 0, db_state.last_error_at || 0)
    now - last_attempt >= min_gap_ms
  end

  # ---------------------------------------------------------------------------
  # Private — poll cycle (with plan_fetched state tracking)
  # ---------------------------------------------------------------------------

  # Runs a full poll cycle. Returns the updated plan_fetched boolean.
  defp do_poll_cycle_stateful(client, token, now, plan_fetched) do
    if is_nil(token) do
      Queries.set_error("missing_credentials", now)
      broadcast_snapshot(now)
      plan_fetched
    else
      # Only fetch plan once per process lifetime; plan rarely changes.
      new_plan_fetched =
        if plan_fetched do
          plan_fetched
        else
          fetch_and_persist_plan(client, token)
          true
        end

      case client.(:usage, token: token) do
        {:ok, buckets} ->
          process_buckets(buckets, now)

        {:error, kind} ->
          Queries.set_error(Atom.to_string(kind), now)
          broadcast_snapshot(now)
      end

      new_plan_fetched
    end
  end

  # Standalone version used by poll_once/1 (no plan_fetched tracking needed).
  defp do_poll_cycle(client, token, now) do
    if is_nil(token) do
      Queries.set_error("missing_credentials", now)
      broadcast_snapshot(now)
    else
      fetch_and_persist_plan(client, token)

      case client.(:usage, token: token) do
        {:ok, buckets} ->
          process_buckets(buckets, now)

        {:error, kind} ->
          Queries.set_error(Atom.to_string(kind), now)
          broadcast_snapshot(now)
      end
    end

    :ok
  end

  # Best-effort plan fetch. Errors are silently ignored; plan is optional.
  defp fetch_and_persist_plan(client, token) do
    case client.(:plan, token: token) do
      {:ok, plan} when is_binary(plan) ->
        Queries.set_plan(plan)

      _ ->
        :ok
    end
  end

  # Upserts buckets, detects threshold crossings, sets observed_at, broadcasts.
  defp process_buckets(buckets, now) do
    db_buckets =
      Enum.map(buckets, fn b ->
        %{
          bucket_id: b.id,
          utilization: b.utilization,
          reset_at: b.reset_at,
          window_started_at: b.window_started_at,
          observed_at: now
        }
      end)

    Queries.replace_all(db_buckets)
    Queries.clear_notified_if_reset()

    # Detect and broadcast threshold crossings before the snapshot so clients
    # receive them in-order: threshold_crossed always arrives before snapshot.
    for b <- Queries.list_buckets() do
      detect_and_emit_crossing(b)
    end

    Queries.set_observed(now)
    broadcast_snapshot(now)
  end

  # Emits a threshold_crossed event when utilization has just crossed a level.
  defp detect_and_emit_crossing(b) do
    notified = b.last_notified_threshold || 0

    cond do
      b.utilization >= 0.90 and notified < 90 ->
        Queries.mark_notified(b.bucket_id, 90, b.reset_at)

        Phoenix.PubSub.broadcast(FBI.PubSub, "usage", %{
          type: "threshold_crossed",
          bucket_id: b.bucket_id,
          threshold: 90,
          reset_at: b.reset_at
        })

      b.utilization >= 0.75 and notified < 75 ->
        Queries.mark_notified(b.bucket_id, 75, b.reset_at)

        Phoenix.PubSub.broadcast(FBI.PubSub, "usage", %{
          type: "threshold_crossed",
          bucket_id: b.bucket_id,
          threshold: 75,
          reset_at: b.reset_at
        })

      true ->
        :ok
    end
  end

  # ---------------------------------------------------------------------------
  # Private — snapshot helpers
  # ---------------------------------------------------------------------------

  defp broadcast_snapshot(now) do
    Phoenix.PubSub.broadcast(FBI.PubSub, "usage", %{type: "snapshot", state: snapshot(now)})
  end

  # Converts a DB bucket row to the wire shape used in snapshots.
  defp bucket_to_wire(b) do
    %{
      id: b.bucket_id,
      utilization: b.utilization,
      reset_at: b.reset_at,
      window_started_at: b.window_started_at
    }
  end

  # Converts a pacing zone atom to the lowercase string expected on the wire.
  defp verdict_to_wire(:none), do: "none"
  defp verdict_to_wire(:chill), do: "chill"
  defp verdict_to_wire(:on_track), do: "on_track"
  defp verdict_to_wire(:hot), do: "hot"

  # ---------------------------------------------------------------------------
  # Private — timer scheduling
  # ---------------------------------------------------------------------------

  # Schedules the first tick based on persisted state so we don't poll
  # immediately after a restart if the last poll was recent.
  defp schedule_first_tick(interval_ms) do
    now = System.system_time(:millisecond)
    db_state = Queries.get_state()

    # Use the most recent of observed_at and last_error_at as the "last attempt"
    # timestamp.  This persisted value survives restarts, so a server that
    # crashed 30 seconds into a 5-minute window will wait ~4m30s before the
    # first post-restart poll.
    last_attempt = max(db_state.observed_at || 0, db_state.last_error_at || 0)
    since_last = now - last_attempt
    delay = max(0, interval_ms - since_last)

    Process.send_after(self(), :tick, delay)
  end

  # ---------------------------------------------------------------------------
  # Private — default production client
  # ---------------------------------------------------------------------------

  defp default_client(:usage, opts), do: FBI.Usage.OAuthClient.fetch_usage(opts)
  defp default_client(:plan, opts), do: FBI.Usage.OAuthClient.fetch_plan(opts)
end
