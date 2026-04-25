defmodule FBI.Orchestrator.ContinueEligibility do
  @moduledoc "Port of src/server/orchestrator/continueEligibility.ts."

  alias FBI.Orchestrator.SessionId

  @terminal_states ~w(failed cancelled succeeded)

  @spec check(map(), String.t()) :: :ok | {:error, atom(), String.t()}
  def check(%{state: state} = run, runs_dir) do
    cond do
      state not in @terminal_states ->
        {:error, :wrong_state, "run is #{state}; only terminal runs can be continued"}

      is_nil(run.claude_session_id) ->
        {:error, :no_session, "no claude session captured for this run"}

      not has_jsonl?(SessionId.mount_dir(runs_dir, run.id)) ->
        {:error, :session_files_missing, "claude session files are no longer on disk"}

      true ->
        :ok
    end
  end

  defp has_jsonl?(dir) do
    case File.ls(dir) do
      {:error, _} ->
        false

      {:ok, subs} ->
        Enum.any?(subs, fn sub ->
          case File.ls(Path.join(dir, sub)) do
            {:ok, files} -> Enum.any?(files, &String.ends_with?(&1, ".jsonl"))
            _ -> false
          end
        end)
    end
  end
end
