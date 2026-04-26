defmodule FBI.Quantico do
  @moduledoc "Helpers around the Quantico mock-Claude binary."

  @scenarios_path Path.expand("../../../cli/quantico/scenarios.json", __DIR__)

  @spec load_scenario_names() :: MapSet.t(String.t())
  def load_scenario_names do
    case File.read(@scenarios_path) do
      {:ok, raw} ->
        %{"scenarios" => names} = Jason.decode!(raw)
        MapSet.new(names)
      {:error, _} -> MapSet.new()
    end
  end
end
