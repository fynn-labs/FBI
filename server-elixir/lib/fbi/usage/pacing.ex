defmodule FBI.Usage.Pacing do
  @moduledoc """
  Pure-functional pacing deltas for rate-limit buckets.

  Given a usage bucket (utilization 0.0-1.0, a window start time, and a reset time), returns
  whether we're ahead, behind, or on track relative to a straight-line utilization target.
  """

  @type bucket_id :: String.t()

  @type bucket :: %{
          required(:id) => bucket_id(),
          required(:utilization) => float(),
          required(:reset_at) => integer() | nil,
          required(:window_started_at) => integer() | nil
        }

  @type zone :: :none | :chill | :on_track | :hot

  @type verdict :: %{delta: float(), zone: zone()}

  # Known bucket IDs and their window durations in ms. Unknown IDs have to derive duration from
  # `reset_at - window_started_at`.
  @known_windows %{
    "five_hour" => 5 * 3_600_000,
    "weekly" => 7 * 24 * 3_600_000,
    "sonnet_weekly" => 7 * 24 * 3_600_000
  }

  @doc """
  Returns known bucket IDs and their window durations in milliseconds. Used by the poller to
  translate Anthropic's bucket ids (`seven_day` etc.) to the internal short names this module
  understands.
  """
  @spec known_windows() :: %{optional(bucket_id()) => integer()}
  def known_windows, do: @known_windows

  @doc """
  Returns a pacing verdict for a bucket at the given wall-clock time (ms since epoch). `:none`
  means "too early to judge" or "bucket data incomplete"; the other zones reflect how user
  utilization compares to linear progress through the window.
  """
  @spec derive_pacing(bucket(), integer()) :: verdict()
  def derive_pacing(bucket, now) do
    case resolve_window_start(bucket) do
      nil ->
        none()

      _window_start when bucket.reset_at == nil ->
        none()

      window_start ->
        duration = duration_for(bucket, window_start)
        compute(bucket, window_start, duration, now)
    end
  end

  # Private helpers

  defp compute(_bucket, _start, duration, _now) when duration <= 0, do: none()

  defp compute(bucket, window_start, duration, now) do
    elapsed = now - window_start
    progress = elapsed / duration

    if progress < 0.05 do
      none()
    else
      u_expected = progress |> max(0.0) |> min(1.0)
      delta = bucket.utilization - u_expected
      %{delta: delta, zone: zone_for(delta)}
    end
  end

  defp zone_for(delta) when delta <= -0.05, do: :chill
  defp zone_for(delta) when delta >= 0.10, do: :hot
  defp zone_for(_delta), do: :on_track

  defp resolve_window_start(%{window_started_at: wsa}) when is_integer(wsa), do: wsa

  defp resolve_window_start(%{id: id, reset_at: reset_at}) when is_integer(reset_at) do
    case Map.get(@known_windows, id) do
      nil -> nil
      dur -> reset_at - dur
    end
  end

  defp resolve_window_start(_), do: nil

  defp duration_for(%{id: id, reset_at: reset_at}, window_start) do
    Map.get(@known_windows, id) || reset_at - window_start
  end

  defp none, do: %{delta: +0.0, zone: :none}
end
