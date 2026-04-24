defmodule FBI.Orchestrator.WipRepo do
  @moduledoc """
  Manages per-run bare git repositories used as a safeguard mirror.

  Each run gets a bare repo at `<runs_dir>/<run_id>/wip.git`. The container's
  `supervisor.sh` pushes to it via the `/safeguard` bind mount so the server
  always has a copy of the latest committed state.

  This is a plain module (no GenServer). All functions are synchronous
  wrappers around `git` shell-outs and filesystem operations.
  """

  @doc "Absolute path to the bare repo for `run_id`."
  @spec path(Path.t(), pos_integer()) :: Path.t()
  def path(runs_dir, run_id), do: Path.join([runs_dir, to_string(run_id), "wip.git"])

  @doc "True if the bare repo's HEAD file exists."
  @spec exists?(Path.t(), pos_integer()) :: boolean()
  def exists?(runs_dir, run_id), do: File.exists?(Path.join(path(runs_dir, run_id), "HEAD"))

  @doc """
  Create the bare repo if it does not already exist. Sets `core.sharedRepository`
  to `group` so both the server user and the container's agent user can push.
  Returns the path to the bare repo.
  """
  @spec init(Path.t(), pos_integer()) :: Path.t()
  def init(runs_dir, run_id) do
    p = path(runs_dir, run_id)
    unless exists?(runs_dir, run_id) do
      File.mkdir_p!(p)
      git!(p, ~w[init --quiet --bare --initial-branch wip] ++ [p])
      git!(p, ~w[-C] ++ [p] ++ ~w[config core.sharedRepository group])
    end
    p
  end

  @doc "Remove the bare repo and its parent directory if empty."
  @spec remove(Path.t(), pos_integer()) :: :ok
  def remove(runs_dir, run_id) do
    p = path(runs_dir, run_id)
    File.rm_rf(p)
    parent = Path.dirname(p)
    File.rmdir(parent)
    :ok
  end

  @doc "Return the current SHA of refs/heads/wip, or nil if no commits yet."
  @spec snapshot_sha(Path.t(), pos_integer()) :: String.t() | nil
  def snapshot_sha(runs_dir, run_id) do
    if not exists?(runs_dir, run_id) do
      nil
    else
      p = path(runs_dir, run_id)
      case git(p, ~w[rev-parse --verify -q refs/heads/wip]) do
        {:ok, sha} ->
          trimmed = String.trim(sha)
          if trimmed == "", do: nil, else: trimmed
        {:error, _} ->
          nil
      end
    end
  end

  @doc "Return the parent SHA of the wip tip, or nil."
  @spec parent_sha(Path.t(), pos_integer()) :: String.t() | nil
  def parent_sha(runs_dir, run_id) do
    case snapshot_sha(runs_dir, run_id) do
      nil -> nil
      sha ->
        p = path(runs_dir, run_id)
        case git(p, ["rev-parse", "#{sha}^"]) do
          {:ok, out} -> String.trim(out)
          {:error, _} -> nil
        end
    end
  end

  @doc """
  Return the list of files changed in the wip tip commit.
  Each entry is `%{path, status, additions: 0, deletions: 0}`.
  Returns [] if no commits yet.
  """
  @spec read_snapshot_files(Path.t(), pos_integer()) :: [map()]
  def read_snapshot_files(runs_dir, run_id) do
    case snapshot_sha(runs_dir, run_id) do
      nil -> []
      snap ->
        p = path(runs_dir, run_id)
        case git(p, ["show", "--no-color", "--name-status", "--format=", snap]) do
          {:ok, out} ->
            out
            |> String.split("\n", trim: true)
            |> Enum.map(fn line ->
              [status_raw | rest] = String.split(line, "\t")
              status = String.at(status_raw, 0) || "M"
              %{path: Enum.join(rest, "\t"), status: status, additions: 0, deletions: 0}
            end)
          {:error, _} -> []
        end
    end
  end

  @doc "Delete refs/heads/wip from the bare repo (idempotent)."
  @spec delete_wip_ref(Path.t(), pos_integer()) :: :ok
  def delete_wip_ref(runs_dir, run_id) do
    if exists?(runs_dir, run_id) do
      p = path(runs_dir, run_id)
      git(p, ["-C", p, "update-ref", "-d", "refs/heads/wip"])
    end
    :ok
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp git(cwd, args) do
    case System.cmd("git", args, cd: cwd, stderr_to_stdout: true) do
      {out, 0} -> {:ok, out}
      {out, _} -> {:error, out}
    end
  end

  defp git!(cwd, args) do
    case git(cwd, args) do
      {:ok, out} -> out
      {:error, msg} -> raise "git #{inspect(args)} failed: #{msg}"
    end
  end
end
