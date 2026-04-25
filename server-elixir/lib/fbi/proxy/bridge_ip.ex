defmodule FBI.Proxy.BridgeIp do
  @moduledoc "Mirrors TS src/server/api/proxy.ts pickBridgeIp."

  @spec pick(map() | nil) :: String.t() | nil
  def pick(nil), do: nil

  def pick(inspect) do
    direct = get_in(inspect, ["NetworkSettings", "IPAddress"])

    cond do
      is_binary(direct) and direct != "" -> direct
      true -> first_network_ip(get_in(inspect, ["NetworkSettings", "Networks"]))
    end
  end

  defp first_network_ip(networks) when is_map(networks) do
    networks
    |> Map.values()
    |> Enum.find_value(fn
      %{"IPAddress" => ip} when is_binary(ip) and ip != "" -> ip
      _ -> nil
    end)
  end

  defp first_network_ip(_), do: nil
end
