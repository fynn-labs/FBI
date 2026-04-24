defmodule FBIWeb.GithubController do
  @moduledoc """
  GitHub integration for a run: read PR/CI status (cached 10s), create a PR,
  and merge the branch.

  Conflict path: when `gh` reports a merge conflict, Elixir returns
  `409 { merged: false, reason: "conflict" }`. The auto-resolution prompt
  injection that TS performs depends on the orchestrator (Phase 7); it is
  NOT performed here during the crossover.
  """

  use FBIWeb, :controller

  alias FBI.Github.{Client, Repo, StatusCache}
  alias FBI.Projects.Queries, as: Projects
  alias FBI.Runs.Queries, as: Runs

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id) do
      case StatusCache.get(id) do
        {:hit, v} ->
          json(conn, v)

        :miss ->
          payload = compute_payload(run)
          StatusCache.put(id, payload)
          json(conn, payload)
      end
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def create_pr(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         true <-
           (is_binary(run.branch_name) and byte_size(run.branch_name) > 0) or {:error, :no_branch},
         {:ok, project} <- Projects.get(run.project_id),
         {:ok, repo} <- Repo.parse(project.repo_url),
         true <- Client.available?() or {:error, :gh_unavailable} do
      case Client.pr_for_branch(repo, run.branch_name) do
        {:ok, pr} when is_map(pr) ->
          conn |> put_status(409) |> json(%{error: "PR already exists", pr: pr})

        _ ->
          title =
            run.prompt |> String.split("\n", parts: 2) |> List.first() |> String.slice(0, 72)

          body = run.prompt <> "\n\n---\nGenerated with FBI run ##{id}"

          case Client.create_pr(repo, %{
                 head: run.branch_name,
                 base: project.default_branch,
                 title: title,
                 body: body
               }) do
            {:ok, pr} ->
              StatusCache.invalidate(id)
              json(conn, pr)

            {:error, _} ->
              conn |> put_status(500) |> json(%{error: "gh create failed"})
          end
      end
    else
      {:error, :no_branch} ->
        conn |> put_status(400) |> json(%{error: "run has no branch to open a PR from"})

      {:error, :gh_unavailable} ->
        conn |> put_status(503) |> json(%{error: "gh-not-available"})

      _ ->
        conn |> put_status(400) |> json(%{error: "not a github project"})
    end
  end

  def merge(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         {:ok, project} <- Projects.get(run.project_id),
         {:ok, repo} <- Repo.parse(project.repo_url),
         true <-
           (is_binary(run.branch_name) and byte_size(run.branch_name) > 0) or {:error, :no_branch},
         true <- Client.available?() or {:error, :gh_unavailable} do
      commit_msg = "Merge branch '#{run.branch_name}' (FBI run ##{id})"

      case Client.merge_branch(repo, run.branch_name, project.default_branch, commit_msg) do
        {:ok, %{merged: true} = payload} ->
          StatusCache.invalidate(id)
          json(conn, payload)

        {:ok, %{merged: false, reason: :already_merged}} ->
          StatusCache.invalidate(id)
          json(conn, %{merged: false, reason: "already-merged"})

        {:ok, %{merged: false, reason: :conflict}} ->
          conn |> put_status(409) |> json(%{merged: false, reason: "conflict"})

        {:error, _} ->
          conn |> put_status(500) |> json(%{merged: false, reason: "gh-error"})
      end
    else
      {:error, :no_branch} ->
        conn |> put_status(400) |> json(%{merged: false, reason: "no-branch"})

      {:error, :gh_unavailable} ->
        conn |> put_status(503) |> json(%{merged: false, reason: "gh-not-available"})

      _ ->
        conn |> put_status(400) |> json(%{merged: false, reason: "not-github"})
    end
  end

  defp compute_payload(run) do
    with {:ok, project} <- Projects.get(run.project_id),
         {:ok, repo} <- Repo.parse(project.repo_url),
         true <- Client.available?() do
      pr = Client.pr_for_branch(repo, run.branch_name) |> elem(1)

      checks =
        case Client.pr_checks(repo, run.branch_name) do
          {:ok, list} -> summarize_checks(list)
          _ -> nil
        end

      commits =
        case Client.commits_on_branch(repo, run.branch_name) do
          {:ok, list} -> list
          _ -> []
        end

      %{pr: pr, checks: checks, commits: commits, github_available: true}
    else
      _ -> %{pr: nil, checks: nil, commits: [], github_available: false}
    end
  end

  defp summarize_checks([]), do: nil

  defp summarize_checks(list) do
    items =
      Enum.map(list, fn c ->
        %{
          name: c["name"] || "",
          status:
            if(c["status"] == "COMPLETED" or c["status"] == "completed",
              do: "completed",
              else: "pending"
            ),
          conclusion: conclusion(c["conclusion"]),
          duration_ms: nil
        }
      end)

    passed = Enum.count(items, &(&1.conclusion == "success"))
    failed = Enum.count(items, &(&1.conclusion == "failure"))
    total = length(items)

    state =
      cond do
        Enum.any?(items, &(&1.status == "pending")) -> "pending"
        failed > 0 -> "failure"
        passed > 0 -> "success"
        true -> "pending"
      end

    %{state: state, passed: passed, failed: failed, total: total, items: items}
  end

  defp conclusion(nil), do: nil

  defp conclusion(s) when is_binary(s) do
    case String.downcase(s) do
      "success" -> "success"
      "failure" -> "failure"
      "neutral" -> "neutral"
      "skipped" -> "skipped"
      "cancelled" -> "cancelled"
      _ -> nil
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
