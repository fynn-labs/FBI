defmodule FBI.Usage.OAuthClient do
  @moduledoc """
  Stateless HTTP client for the Anthropic OAuth endpoints consumed by the usage
  poller.

  Single responsibility: make the HTTP call, parse the response, return
  normalized data. No scheduling logic, no GenServer — just functions.

  The two endpoints are:
  - `#{inspect("https://api.anthropic.com/api/oauth/usage")}` — per-bucket
    utilization data.
  - `#{inspect("https://api.anthropic.com/api/oauth/profile")}` — account
    profile used to derive the user's plan tier.
  """

  alias FBI.Usage.Pacing

  @usage_url "https://api.anthropic.com/api/oauth/usage"
  @profile_url "https://api.anthropic.com/api/oauth/profile"
  @beta_header "oauth-2025-04-20"

  # The live API keys buckets by their external names. We translate them to the
  # internal short names so the rest of the app (labels, pacing windows, tests)
  # keeps the names it already uses. Unknown keys pass through unchanged.
  @bucket_id_alias %{
    "seven_day" => "weekly",
    "seven_day_sonnet" => "sonnet_weekly"
  }

  # Top-level keys on the /oauth/usage response that are NOT rate-limit buckets.
  @non_bucket_keys MapSet.new(["extra_usage"])

  @type bucket :: %{
          id: String.t(),
          utilization: float(),
          reset_at: integer() | nil,
          window_started_at: integer() | nil
        }

  @type error_kind :: :expired | :rate_limited | :network

  @doc """
  Fetches per-bucket utilization data from the Anthropic OAuth usage endpoint.

  ## Options

  - `:token` (required) — Bearer token for the `authorization` header.
  - `:req_opts` (optional) — keyword list merged into the underlying `Req.get/2`
    call. Useful for injecting a `plug:` stub in tests.

  ## Return value

  - `{:ok, [bucket]}` on success, where each bucket is a map with `:id`,
    `:utilization` (0.0–1.0 float), `:reset_at` (ms epoch integer or nil), and
    `:window_started_at` (ms epoch integer or nil).
  - `{:error, :expired}` when the server returns HTTP 401.
  - `{:error, :rate_limited}` when the server returns HTTP 429.
  - `{:error, :network}` for any other non-2xx response, request error, or
    parse failure.
  """
  @spec fetch_usage(keyword()) :: {:ok, [bucket()]} | {:error, error_kind()}
  def fetch_usage(opts) do
    token = Keyword.fetch!(opts, :token)
    req_opts = Keyword.get(opts, :req_opts, [])

    base_opts = [
      headers: [
        {"authorization", "Bearer #{token}"},
        {"anthropic-beta", @beta_header}
      ],
      retry: false
    ]

    case Req.get(@usage_url, Keyword.merge(base_opts, req_opts)) do
      {:ok, %{status: 401}} ->
        {:error, :expired}

      {:ok, %{status: 429}} ->
        {:error, :rate_limited}

      {:ok, %{status: status, body: body}} when status in 200..299 ->
        {:ok, normalize_usage(body)}

      {:ok, _} ->
        {:error, :network}

      {:error, _} ->
        {:error, :network}
    end
  end

  @doc """
  Fetches the Anthropic account profile and derives the user's plan tier.

  ## Options

  - `:token` (required) — Bearer token for the `authorization` header.
  - `:req_opts` (optional) — keyword list merged into the underlying `Req.get/2`
    call. Useful for injecting a `plug:` stub in tests.

  ## Return value

  - `{:ok, plan}` where `plan` is `"pro"`, `"max"`, `"team"`, or `nil` when no
    plan can be derived from the response.
  - `{:error, :expired}` when the server returns HTTP 401.
  - `{:error, :rate_limited}` when the server returns HTTP 429.
  - `{:error, :network}` for any other non-2xx response or request error.
  """
  @spec fetch_plan(keyword()) :: {:ok, String.t() | nil} | {:error, error_kind()}
  def fetch_plan(opts) do
    token = Keyword.fetch!(opts, :token)
    req_opts = Keyword.get(opts, :req_opts, [])

    base_opts = [
      headers: [
        {"authorization", "Bearer #{token}"},
        {"anthropic-beta", @beta_header}
      ],
      retry: false
    ]

    case Req.get(@profile_url, Keyword.merge(base_opts, req_opts)) do
      {:ok, %{status: 401}} ->
        {:error, :expired}

      {:ok, %{status: 429}} ->
        {:error, :rate_limited}

      {:ok, %{status: status, body: body}} when status in 200..299 ->
        {:ok, derive_plan(body)}

      {:ok, _} ->
        {:error, :network}

      {:error, _} ->
        {:error, :network}
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Normalizes the raw /oauth/usage response body into a list of bucket maps.
  # Supports both the live shape (top-level keys = bucket ids) and the legacy
  # shape ({ "buckets": [...] }).
  defp normalize_usage(raw) when is_map(raw) do
    entries = extract_entries(raw)
    known_windows = Pacing.known_windows()

    for {raw_key, r} <- entries,
        is_map(r),
        u = coerce_number(r["utilization"]),
        is_float(u),
        reset_at = to_ms_epoch(r["resets_at"]),
        reset_at != nil do
      id = Map.get(@bucket_id_alias, raw_key, raw_key)
      utilization = max(0.0, min(1.0, u / 100.0))
      win_start = to_ms_epoch(r["window_started_at"])

      window_started_at =
        win_start ||
          case Map.get(known_windows, id) do
            nil -> nil
            dur -> reset_at - dur
          end

      %{
        id: id,
        utilization: utilization,
        reset_at: reset_at,
        window_started_at: window_started_at
      }
    end
  end

  defp normalize_usage(_), do: []

  # Returns a list of {id, raw_bucket_map} pairs from the response body.
  defp extract_entries(%{"buckets" => buckets}) when is_list(buckets) do
    for b <- buckets,
        is_map(b),
        id = to_string(b["id"] || ""),
        id != "" do
      {id, b}
    end
  end

  defp extract_entries(raw) do
    for {k, v} <- raw,
        not MapSet.member?(@non_bucket_keys, k),
        is_map(v) do
      {k, v}
    end
  end

  # Converts an ISO-8601 string or numeric value to a millisecond epoch integer,
  # or nil if the value cannot be coerced.
  defp to_ms_epoch(v) when is_binary(v) do
    case DateTime.from_iso8601(v) do
      {:ok, dt, _offset} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end

  defp to_ms_epoch(v) when is_number(v) do
    if v < 1.0e12, do: round(v * 1000), else: round(v)
  end

  defp to_ms_epoch(_), do: nil

  # Coerces a utilization value to a float, or returns nil if non-finite.
  defp coerce_number(v) when is_integer(v), do: v * 1.0
  defp coerce_number(v) when is_float(v), do: v

  defp coerce_number(v) when is_binary(v) do
    case Float.parse(v) do
      {f, ""} -> f
      _ -> nil
    end
  end

  defp coerce_number(_), do: nil

  # Derives the plan tier from the profile response body.
  defp derive_plan(%{"plan" => plan}) when plan in ["pro", "max", "team"], do: plan

  defp derive_plan(%{"organization" => %{"organization_type" => org_type}})
       when org_type in ["team", "enterprise"],
       do: "team"

  defp derive_plan(%{"account" => %{"has_claude_max" => true}}), do: "max"
  defp derive_plan(%{"account" => %{"has_claude_pro" => true}}), do: "pro"
  defp derive_plan(_), do: nil
end
