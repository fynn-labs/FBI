defmodule FBI.Orchestrator.ResumeDetector do
  @moduledoc "Port of src/server/orchestrator/resumeDetector.ts."

  @tail_bytes 8 * 1024
  @twenty_four_hours_ms 24 * 60 * 60 * 1000

  @re_pipe_epoch ~r/Claude usage limit reached\|(\d+)/
  @re_human ~r/Claude usage limit reached\. Your limit will reset at ([^.]+)\./
  @re_human_new ~r/hit your limit[^A-Za-z\n]+resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m(?:\s*\([^)\n]+\))?)/i
  @re_lenient ~r/(?:usage limit|rate limit|hit your limit)/i
  @ansi_re ~r/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/

  @type rate_limit_state :: %{
          requests_remaining: integer() | nil,
          requests_limit: integer() | nil,
          tokens_remaining: integer() | nil,
          tokens_limit: integer() | nil,
          reset_at: integer() | nil
        }

  @type verdict :: %{
          kind: :rate_limit | :other,
          reset_at: integer() | nil,
          source: :log_epoch | :log_text | :rate_limit_state | :fallback_clamp | nil
        }

  @spec strip_ansi(String.t()) :: String.t()
  def strip_ansi(s), do: Regex.replace(@ansi_re, s, "")

  @spec contains_limit_signal(String.t()) :: boolean()
  def contains_limit_signal(tail) do
    t = strip_ansi(tail)

    Regex.match?(@re_pipe_epoch, t) or Regex.match?(@re_human, t) or
      Regex.match?(@re_human_new, t)
  end

  @spec classify(String.t(), rate_limit_state() | nil, integer()) :: verdict()
  def classify(log_tail, state, now) do
    raw =
      if byte_size(log_tail) > @tail_bytes,
        do: binary_part(log_tail, byte_size(log_tail) - @tail_bytes, @tail_bytes),
        else: log_tail

    tail = strip_ansi(raw)

    with nil <- try_pipe_epoch(tail, now),
         nil <- try_human(tail, now),
         nil <- try_lenient(tail, state, now),
         nil <- classify_from_state(state, now) do
      %{kind: :other, reset_at: nil, source: nil}
    end
  end

  defp try_pipe_epoch(tail, now) do
    case Regex.run(@re_pipe_epoch, tail) do
      [_, ms_str] -> sanity_clamp(String.to_integer(ms_str), :log_epoch, now)
      _ -> nil
    end
  end

  defp try_human(tail, now) do
    match = Regex.run(@re_human, tail) || Regex.run(@re_human_new, tail)

    case match do
      [_, time_str] ->
        case parse_human_reset_time(time_str, now) do
          nil -> nil
          ms -> sanity_clamp(ms, :log_text, now)
        end

      _ ->
        nil
    end
  end

  defp try_lenient(tail, state, now) do
    if Regex.match?(@re_lenient, tail) do
      classify_from_state(state, now) ||
        %{kind: :rate_limit, reset_at: now + 5 * 60_000, source: :fallback_clamp}
    else
      nil
    end
  end

  defp classify_from_state(nil, _now), do: nil

  defp classify_from_state(state, now) do
    zero = state[:requests_remaining] == 0 or state[:tokens_remaining] == 0
    reset_at = state[:reset_at]

    if zero and is_integer(reset_at) and reset_at > now and
         reset_at <= now + @twenty_four_hours_ms do
      %{kind: :rate_limit, reset_at: reset_at, source: :rate_limit_state}
    else
      nil
    end
  end

  defp sanity_clamp(ms, source, now) do
    cond do
      ms > now + @twenty_four_hours_ms -> %{kind: :other, reset_at: nil, source: nil}
      ms <= now -> %{kind: :rate_limit, reset_at: now + 60_000, source: :fallback_clamp}
      true -> %{kind: :rate_limit, reset_at: ms, source: source}
    end
  end

  defp parse_human_reset_time(text, now) do
    trimmed = String.trim(text)

    {time_part, _tz} =
      case Regex.run(~r/^(.*?)\s*\(([A-Za-z_]+\/[A-Za-z_]+|[A-Z]{2,4})\)\s*$/, trimmed) do
        [_, t, z] -> {String.trim(t), z}
        _ -> {trimmed, nil}
      end

    case Regex.run(~r/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i, time_part) do
      [_, h_str, min_str, mer] ->
        hour = String.to_integer(h_str)
        minute = if min_str == "", do: 0, else: String.to_integer(min_str)
        hour = adjust_hour(hour, String.downcase(mer))
        resolve_local_time(now, hour, minute)

      _ ->
        nil
    end
  end

  defp adjust_hour(12, "am"), do: 0
  defp adjust_hour(h, "pm") when h != 12, do: h + 12
  defp adjust_hour(h, _), do: h

  defp resolve_local_time(now, hour, minute) do
    now_dt = DateTime.from_unix!(div(now, 1000))
    today = DateTime.to_date(now_dt)

    case Time.new(hour, minute, 0) do
      {:ok, t} ->
        dt = DateTime.new!(today, t, "Etc/UTC")
        DateTime.to_unix(dt, :millisecond)

      _ ->
        nil
    end
  end
end
