defmodule FBI.Orchestrator.SafeguardRepo do
  @moduledoc """
  Read-only helpers for a safeguard bare git repository.

  The safeguard bare repo is created by `WipRepo.init/2` and populated by
  `supervisor.sh` inside the container. This module only reads from it.
  Used by the changes endpoint and SafeguardWatcher.

  All functions are synchronous; they shell out to `git` and return safe
  defaults (empty lists / nil) on any error.
  """

  @doc "True if the bare repo's HEAD file exists."
  @spec exists?(Path.t()) :: boolean()
  def exists?(bare_dir), do: File.exists?(Path.join(bare_dir, "HEAD"))

  @doc "Return `%{sha, subject}` for the tip of `branch`, or nil."
  @spec head(Path.t(), String.t()) :: %{sha: String.t(), subject: String.t()} | nil
  def head(bare_dir, branch) do
    if not ref_exists?(bare_dir, branch) do
      nil
    else
      case git(bare_dir, ["log", "-1", "--format=%H\x00%s", "refs/heads/#{branch}"]) do
        {:ok, raw} ->
          case String.split(raw, "\x00", parts: 2) do
            [sha, subject] ->
              %{sha: String.trim(sha), subject: String.trim_trailing(subject, "\n")}
            _ ->
              nil
          end
        {:error, _} ->
          nil
      end
    end
  end

  @doc """
  Return commits reachable from `branch` but not from `base_sha`, newest-first.
  `base_sha` = "" means all commits. Returns [] on any error.
  """
  @spec list_commits(Path.t(), String.t(), String.t()) :: [map()]
  def list_commits(bare_dir, branch, base_sha) do
    if not ref_exists?(bare_dir, branch) do
      []
    else
      real_sha? =
        Regex.match?(~r/^[0-9a-f]{40}$/, base_sha) and
          base_sha != String.duplicate("0", 40)

      spec =
        if real_sha?,
          do: "#{base_sha}..refs/heads/#{branch}",
          else: "refs/heads/#{branch}"

      case git(bare_dir, ["log", "--format=%H\x00%s\x00%ct", spec]) do
        {:ok, raw} ->
          raw
          |> String.split("\n", trim: true)
          |> Enum.flat_map(fn line ->
            case String.split(line, "\x00") do
              [sha, subject, ts_str] ->
                ts =
                  case Integer.parse(ts_str) do
                    {n, ""} -> n
                    _ -> 0
                  end

                [
                  %{
                    sha: sha,
                    subject: subject,
                    committed_at: ts,
                    pushed: false,
                    files: [],
                    files_loaded: false,
                    submodule_bumps: []
                  }
                ]

              _ ->
                []
            end
          end)

        {:error, _} ->
          []
      end
    end
  end

  @doc "Return the list of files changed in the tip commit of `branch`."
  @spec head_files(Path.t(), String.t()) :: [map()]
  def head_files(bare_dir, branch) do
    if not ref_exists?(bare_dir, branch) do
      []
    else
      case git(bare_dir, ["show", "--numstat", "--format=", "refs/heads/#{branch}"]) do
        {:ok, raw} -> parse_numstat(raw)
        {:error, _} -> []
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp ref_exists?(bare_dir, branch) do
    if not exists?(bare_dir) do
      false
    else
      case git(bare_dir, ["rev-parse", "--verify", "-q", "refs/heads/#{branch}"]) do
        {:ok, out} -> String.trim(out) != ""
        {:error, _} -> false
      end
    end
  end

  defp git(cwd, args) do
    case System.cmd("git", args, cd: cwd, stderr_to_stdout: true) do
      {out, 0} -> {:ok, out}
      {out, _} -> {:error, out}
    end
  end

  defp parse_numstat(raw) do
    raw
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case String.split(line, "\t") do
        [a_str, d_str, path] ->
          adds = if a_str == "-", do: 0, else: String.to_integer(a_str)
          dels = if d_str == "-", do: 0, else: String.to_integer(d_str)

          status =
            cond do
              dels > 0 and adds == 0 -> "D"
              dels == 0 and adds > 0 -> "A"
              true -> "M"
            end

          [%{path: path, status: status, additions: adds, deletions: dels}]

        _ ->
          []
      end
    end)
  end
end
