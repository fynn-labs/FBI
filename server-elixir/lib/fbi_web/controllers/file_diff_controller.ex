defmodule FBIWeb.FileDiffController do
  @moduledoc """
  GET /api/runs/:id/file-diff?path=<path>&ref=<ref>

  Returns a parsed unified diff for a file. In Phase 7a, only WipRepo diffs
  are available. Worktree ref returns 409 (no live container yet).
  """

  use FBIWeb, :controller

  alias FBI.Runs.Queries, as: RunQ
  alias FBI.Orchestrator.WipRepo

  @path_re ~r|^[\w./@:+-]+$|

  def show(conn, %{"id" => id_str} = params) do
    file_path = params["path"]
    ref = params["ref"] || "worktree"

    cond do
      is_nil(file_path) ->
        conn |> put_status(400) |> json(%{error: "path required"})

      not Regex.match?(@path_re, file_path) ->
        conn |> put_status(400) |> json(%{error: "invalid path"})

      not Regex.match?(@path_re, ref) ->
        conn |> put_status(400) |> json(%{error: "invalid ref"})

      true ->
        case parse_id(id_str) do
          {:ok, run_id} ->
            case RunQ.get(run_id) do
              {:ok, _run} -> serve_diff(conn, run_id, file_path, ref)
              :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
            end

          :error ->
            conn |> put_status(404) |> json(%{error: "not found"})
        end
    end
  end

  defp serve_diff(conn, _run_id, _file_path, "worktree") do
    conn |> put_status(409) |> json(%{error: "no container", message: "container not active"})
  end

  defp serve_diff(conn, run_id, file_path, ref) do
    runs_dir = Application.get_env(:fbi, :runs_dir, "/var/lib/agent-manager/runs")
    bare_dir = WipRepo.path(runs_dir, run_id)
    diff = read_diff_from_wip(bare_dir, ref, file_path)
    json(conn, diff)
  end

  defp read_diff_from_wip(bare_dir, ref, file_path) do
    snap = snap_sha(bare_dir)
    parent = snap && parent_sha(bare_dir, snap)

    if is_nil(snap) or is_nil(parent) do
      %{path: file_path, ref: ref, hunks: [], truncated: false}
    else
      case System.cmd(
             "git",
             [
               "-C",
               bare_dir,
               "diff",
               "--no-color",
               "--no-ext-diff",
               "-U3",
               "#{parent}..#{snap}",
               "--",
               file_path
             ],
             stderr_to_stdout: true
           ) do
        {out, 0} -> parse_unified_diff(out, file_path, ref)
        _ -> %{path: file_path, ref: ref, hunks: [], truncated: false}
      end
    end
  end

  defp snap_sha(bare_dir) do
    case System.cmd("git", ["-C", bare_dir, "rev-parse", "--verify", "-q", "refs/heads/wip"],
           stderr_to_stdout: true
         ) do
      {sha, 0} ->
        trimmed = String.trim(sha)
        if trimmed == "", do: nil, else: trimmed

      _ ->
        nil
    end
  end

  defp parent_sha(bare_dir, snap) do
    case System.cmd("git", ["-C", bare_dir, "rev-parse", "#{snap}^"],
           stderr_to_stdout: true
         ) do
      {sha, 0} -> String.trim(sha)
      _ -> nil
    end
  end

  @max_hunks 50

  defp parse_unified_diff(raw, path, ref) do
    lines = String.split(raw, "\n")
    hunks = parse_hunks(lines)
    truncated = length(hunks) > @max_hunks
    %{path: path, ref: ref, hunks: Enum.take(hunks, @max_hunks), truncated: truncated}
  end

  defp parse_hunks(lines) do
    {acc, current} =
      Enum.reduce(lines, {[], nil}, fn line, {acc, current} ->
        case Regex.run(~r/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/, line) do
          [_, os, ol, ns, nl] ->
            hunk = %{
              old_start: String.to_integer(os),
              old_lines: String.to_integer(ol || "1"),
              new_start: String.to_integer(ns),
              new_lines: String.to_integer(nl || "1"),
              lines: []
            }

            new_acc = if current, do: acc ++ [current], else: acc
            {new_acc, hunk}

          nil when not is_nil(current) ->
            type =
              case line do
                "+" <> _ -> "add"
                "-" <> _ -> "del"
                "\\ " <> _ -> nil
                _ -> "ctx"
              end

            if type do
              updated =
                Map.update!(current, :lines, &(&1 ++ [%{type: type, content: String.slice(line, 1..-1//1)}]))

              {acc, updated}
            else
              {acc, current}
            end

          _ ->
            {acc, current}
        end
      end)

    if current, do: acc ++ [current], else: acc
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
