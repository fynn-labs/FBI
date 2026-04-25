defmodule FBI.Uploads.HumanSize do
  @moduledoc "Mirrors src/server/api/uploads.ts humanSize: B, 1-decimal KB/MB, 2-decimal GB."

  @kb 1024
  @mb 1024 * 1024
  @gb 1024 * 1024 * 1024

  @spec format(integer()) :: String.t()
  def format(n) when n < @kb, do: "#{n} B"
  def format(n) when n < @mb, do: "#{:erlang.float_to_binary(n / @kb, decimals: 1)} KB"
  def format(n) when n < @gb, do: "#{:erlang.float_to_binary(n / @mb, decimals: 1)} MB"
  def format(n), do: "#{:erlang.float_to_binary(n / @gb, decimals: 2)} GB"
end
