defmodule FBI.Proxy.ProcListeners do
  @moduledoc "Parses /proc/net/tcp output for LISTEN-state sockets."

  # Linux TCP_LISTEN constant.
  @listen_state "0A"

  @spec parse(binary()) :: [%{port: integer(), proto: :tcp}]
  def parse(text) when is_binary(text) do
    text
    |> String.split("\n", trim: false)
    |> Enum.reduce(%{seen: MapSet.new(), out: []}, &reduce_line/2)
    |> Map.fetch!(:out)
    |> Enum.reverse()
    |> Enum.sort_by(& &1.port)
  end

  defp reduce_line(raw, %{seen: seen, out: out} = acc) do
    line = String.trim(raw)

    cond do
      line == "" or String.starts_with?(line, "sl") ->
        acc

      true ->
        parts = String.split(line, ~r/\s+/, trim: true)

        case parts do
          [_idx, local, _rem, state | _] when state == @listen_state ->
            with [_addr, port_hex] <- String.split(local, ":", parts: 2),
                 {port, ""} <- Integer.parse(port_hex, 16),
                 true <- port > 0 and port <= 65535,
                 false <- MapSet.member?(seen, port) do
              %{seen: MapSet.put(seen, port), out: [%{port: port, proto: :tcp} | out]}
            else
              _ -> acc
            end

          _ ->
            acc
        end
    end
  end
end
