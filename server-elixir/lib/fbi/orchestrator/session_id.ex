defmodule FBI.Orchestrator.SessionId do
  @moduledoc "Port of src/server/orchestrator/sessionId.ts."

  @uuid_re ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  def mount_dir(runs_dir, run_id), do: Path.join([runs_dir, to_string(run_id), "claude-projects"])
  def state_dir(runs_dir, run_id), do: Path.join([runs_dir, to_string(run_id), "state"])
  def uploads_dir(runs_dir, run_id), do: Path.join([runs_dir, to_string(run_id), "uploads"])
  def scripts_dir(runs_dir, run_id), do: Path.join([runs_dir, to_string(run_id), "scripts"])

  @spec scan_session_id(String.t()) :: String.t() | nil
  def scan_session_id(mount_dir) do
    case File.ls(mount_dir) do
      {:error, _} ->
        nil

      {:ok, subs} ->
        subs
        |> Enum.flat_map(fn sub ->
          sub_path = Path.join(mount_dir, sub)

          case File.ls(sub_path) do
            {:ok, files} ->
              files
              |> Enum.filter(&String.ends_with?(&1, ".jsonl"))
              |> Enum.flat_map(fn file ->
                base = String.slice(file, 0, String.length(file) - 6)

                if Regex.match?(@uuid_re, base) do
                  mtime =
                    case File.stat(Path.join(sub_path, file)) do
                      {:ok, %{mtime: m}} -> :calendar.datetime_to_gregorian_seconds(m)
                      _ -> 0
                    end

                  [{base, mtime}]
                else
                  []
                end
              end)

            _ ->
              []
          end
        end)
        |> Enum.sort_by(fn {_, mtime} -> mtime end, :desc)
        |> case do
          [{uuid, _} | _] -> uuid
          [] -> nil
        end
    end
  end
end
