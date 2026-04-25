defmodule FBIWeb.FileDiffController do
  use FBIWeb, :controller

  alias FBI.Runs.Queries, as: RunQ

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
              {:ok, run} -> serve_diff(conn, run, file_path, ref)
              :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
            end

          :error ->
            conn |> put_status(404) |> json(%{error: "not found"})
        end
    end
  end

  defp serve_diff(conn, run, file_path, ref) do
    if run.container_id do
      cmd =
        if ref == "worktree" do
          ["git", "-C", "/workspace", "diff", "--", file_path]
        else
          ["git", "-C", "/workspace", "show", ref, "--", file_path]
        end

      case exec_git_in_container(run.container_id, cmd) do
        {:ok, stdout} ->
          json(conn, parse_unified_diff(stdout, file_path, ref))

        {:error, reason} ->
          conn |> put_status(409) |> json(%{error: "no container", message: reason})
      end
    else
      conn |> put_status(409) |> json(%{error: "no container", message: "container not active"})
    end
  end

  defp exec_git_in_container(container_id, cmd) do
    try do
      {:ok, exec_id} = FBI.Docker.exec_create(container_id, cmd)
      {:ok, output} = FBI.Docker.exec_start(exec_id, timeout_ms: 5_000)
      {:ok, output}
    rescue
      e -> {:error, Exception.message(e)}
    catch
      _, reason -> {:error, inspect(reason)}
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
                Map.update!(
                  current,
                  :lines,
                  &(&1 ++ [%{type: type, content: String.slice(line, 1..-1//1)}])
                )

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
