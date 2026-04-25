defmodule FBI.Runs.ModelParams do
  @moduledoc "Validates run model/effort/subagent_model. Mirrors src/server/api/modelParams.ts."

  @models ~w(sonnet opus haiku)
  @efforts ~w(low medium high xhigh max)

  @spec validate(map()) :: :ok | {:error, String.t()}
  def validate(params) when is_map(params) do
    model = Map.get(params, :model) || Map.get(params, "model")
    effort = Map.get(params, :effort) || Map.get(params, "effort")
    subagent = Map.get(params, :subagent_model) || Map.get(params, "subagent_model")

    cond do
      model not in [nil | @models] ->
        {:error, "invalid model: #{model}"}

      effort not in [nil | @efforts] ->
        {:error, "invalid effort: #{effort}"}

      subagent not in [nil | @models] ->
        {:error, "invalid subagent_model: #{subagent}"}

      effort != nil and model == "haiku" ->
        {:error, "effort is not supported on haiku"}

      effort == "xhigh" and model != nil and model != "opus" ->
        {:error, "xhigh effort is only supported on opus"}

      true ->
        :ok
    end
  end
end
