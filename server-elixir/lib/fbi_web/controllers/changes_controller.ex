defmodule FBIWeb.ChangesController do
  @moduledoc """
  Routes: GET /api/runs/:id/changes, GET /api/runs/:id/commits/:sha/files,
  GET /api/runs/:id/submodule/*path
  """

  use FBIWeb, :controller

  alias FBI.Runs.Queries, as: RunQ
  alias FBI.Projects.Queries, as: ProjQ
  alias FBI.Orchestrator.SafeguardRepo
  alias FBI.Orchestrator.WipRepo
  alias FBI.Github.Client, as: GH
  alias FBI.Github.Repo, as: GHRepo
  alias FBI.Docker

  def show(conn, %{"id" => id_str}) do
    with {:ok, run_id} <- parse_id(id_str),
         {:ok, run} <- RunQ.get(run_id) do
      payload =
        case FBI.Runs.ChangesCache.get(run_id) do
          {:hit, v} ->
            v

          :miss ->
            v = build_changes(run)
            FBI.Runs.ChangesCache.put(run_id, v)
            v
        end

      json(conn, payload)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def commit_files(conn, %{"id" => id_str, "sha" => sha}) do
    sha_clean = String.replace(sha, ~r/[^0-9a-f]/, "")

    if sha_clean != sha or byte_size(sha_clean) < 7 do
      conn |> put_status(400) |> json(%{error: "invalid sha"})
    else
      with {:ok, run_id} <- parse_id(id_str),
           {:ok, run} <- RunQ.get(run_id) do
        # Prefer docker exec on a live container — works for any commit,
        # pushed or not. Falls back to gh compare for already-pushed commits
        # when no container is available.
        files =
          case files_via_container(run, sha) do
            {:ok, list} -> list
            :no_container -> gh_compare_files(run, sha)
          end

        json(conn, %{files: files})
      else
        _ -> conn |> put_status(404) |> json(%{error: "not found"})
      end
    end
  end

  defp files_via_container(run, sha) do
    case run.container_id do
      cid when is_binary(cid) and cid != "" ->
        case Docker.exec_create(cid, [
               "git",
               "-C",
               "/workspace",
               "show",
               "--numstat",
               "--format=",
               sha
             ]) do
          {:ok, exec_id} ->
            case Docker.exec_start(exec_id, timeout_ms: 5_000) do
              {:ok, output} -> {:ok, parse_numstat(output)}
              _ -> :no_container
            end

          _ ->
            :no_container
        end

      _ ->
        :no_container
    end
  end

  defp parse_numstat(text) do
    text
    |> String.split("\n", trim: true)
    |> Enum.map(fn line ->
      case String.split(line, "\t", parts: 3) do
        [add, del, path] ->
          %{
            path: path,
            status: numstat_status(add, del),
            additions: parse_int_or_zero(add),
            deletions: parse_int_or_zero(del)
          }

        _ ->
          nil
      end
    end)
    |> Enum.reject(&is_nil/1)
  end

  defp numstat_status("0", "0"), do: "M"
  # binary file
  defp numstat_status("-", "-"), do: "M"
  defp numstat_status(_, "0"), do: "A"
  defp numstat_status("0", _), do: "D"
  defp numstat_status(_, _), do: "M"

  defp parse_int_or_zero(s) do
    case Integer.parse(s) do
      {n, _} -> n
      :error -> 0
    end
  end

  def submodule_files(conn, %{"id" => id_str, "path" => raw_path}) do
    raw_path = if is_list(raw_path), do: Enum.join(raw_path, "/"), else: raw_path

    case Regex.run(~r|^(.+)/commits/([0-9a-f]{7,40})/files$|, raw_path) do
      [_, submodule_path, sha] ->
        cond do
          String.contains?(submodule_path, "..") ->
            conn |> put_status(400) |> json(%{error: "invalid path"})

          true ->
            with {:ok, run_id} <- parse_id(id_str),
                 {:ok, run} <- RunQ.get(run_id) do
              files =
                case files_via_submodule(run, submodule_path, sha) do
                  {:ok, list} -> list
                  :no_container -> []
                end

              json(conn, %{files: files})
            else
              _ -> conn |> put_status(404) |> json(%{error: "not found"})
            end
        end

      _ ->
        conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  defp files_via_submodule(run, submodule_path, sha) do
    case run.container_id do
      cid when is_binary(cid) and cid != "" ->
        case Docker.exec_create(cid, [
               "git",
               "-C",
               "/workspace/#{submodule_path}",
               "show",
               "--numstat",
               "--format=",
               sha
             ]) do
          {:ok, exec_id} ->
            case Docker.exec_start(exec_id, timeout_ms: 5_000) do
              {:ok, output} -> {:ok, parse_numstat(output)}
              _ -> :no_container
            end

          _ ->
            :no_container
        end

      _ ->
        :no_container
    end
  end

  defp build_changes(run) do
    bare_dir = WipRepo.path(runs_dir(), run.id)
    branch = run.branch_name

    safeguard_commits =
      if branch do
        SafeguardRepo.list_commits(bare_dir, branch, "")
      else
        []
      end

    {commits, gh_payload, branch_base} = maybe_enrich_with_github(run, safeguard_commits)

    children =
      RunQ.list_by_parent(run.id)
      |> Enum.map(fn r -> %{id: r.id, kind: r.kind, state: r.state, created_at: r.created_at} end)

    %{
      branch_name: branch,
      branch_base: branch_base,
      commits: commits,
      uncommitted: [],
      integrations: if(gh_payload, do: %{github: gh_payload}, else: %{}),
      dirty_submodules: [],
      children: children
    }
  end

  defp maybe_enrich_with_github(run, safeguard_commits) do
    result =
      with pid when not is_nil(pid) <- run.project_id,
           {:ok, project} <- ProjQ.get(pid),
           {:ok, repo_str} <- GHRepo.parse(project.repo_url),
           true <- run.branch_name not in [nil, ""],
           true <- GH.available?() do
        {repo_str, project.default_branch, run.branch_name}
      else
        _ -> nil
      end

    case result do
      nil ->
        {safeguard_commits, nil, nil}

      {repo, base_branch, branch} ->
        pr =
          case GH.pr_for_branch(repo, branch) do
            {:ok, v} -> v
            _ -> nil
          end

        {gh_commits, ahead_by, behind_by, merge_base_sha} =
          case GH.compare_branch(repo, base_branch, branch) do
            {:ok, %{commits: c, ahead_by: a, behind_by: b, merge_base_sha: m}} ->
              {c, a, b, m}

            _ ->
              {[], 0, 0, ""}
          end

        gh_shas = MapSet.new(gh_commits, & &1.sha)

        filtered_safeguard =
          if merge_base_sha == "" do
            safeguard_commits
          else
            # Re-list safeguard commits scoped to the merge base. Cheaper than
            # post-filtering by SHA because list_commits with a base argument
            # already excludes pre-base commits.
            SafeguardRepo.list_commits(
              WipRepo.path(runs_dir(), run.id),
              run.branch_name,
              merge_base_sha
            )
          end

        all_commits =
          Enum.map(gh_commits, fn c ->
            Map.merge(c, %{pushed: true, files: [], files_loaded: false, submodule_bumps: []})
          end) ++
            Enum.reject(filtered_safeguard, fn c -> MapSet.member?(gh_shas, c.sha) end)

        gh_payload = %{
          pr: pr && Map.take(pr, [:number, :url, :state, :title]),
          checks: nil
        }

        branch_base = %{base: base_branch, ahead: ahead_by, behind: behind_by}

        {all_commits, gh_payload, branch_base}
    end
  end

  defp runs_dir, do: Application.get_env(:fbi, :runs_dir, "/var/lib/agent-manager/runs")

  defp gh_compare_files(run, sha) do
    repo =
      with pid when not is_nil(pid) <- run.project_id,
           {:ok, project} <- ProjQ.get(pid),
           {:ok, repo_str} <- GHRepo.parse(project.repo_url) do
        repo_str
      else
        _ -> nil
      end

    if repo && GH.available?() do
      case GH.compare_files(repo, "#{sha}^", sha) do
        {:ok, files} ->
          Enum.map(files, fn f ->
            status =
              case f["status"] do
                "added" -> "A"
                "removed" -> "D"
                "renamed" -> "R"
                _ -> "M"
              end

            %{
              path: f["filename"],
              status: status,
              additions: f["additions"],
              deletions: f["deletions"]
            }
          end)

        _ ->
          []
      end
    else
      []
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
