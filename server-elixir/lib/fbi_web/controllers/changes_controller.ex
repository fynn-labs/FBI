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

  def show(conn, %{"id" => id_str}) do
    with {:ok, run_id} <- parse_id(id_str),
         {:ok, run} <- RunQ.get(run_id) do
      json(conn, build_changes(run))
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
        files = gh_compare_files(run, sha)
        json(conn, %{files: files})
      else
        _ -> conn |> put_status(404) |> json(%{error: "not found"})
      end
    end
  end

  def submodule_files(conn, %{"id" => id_str, "path" => raw_path}) do
    case Regex.run(~r|^(.+)/commits/([0-9a-f]{7,40})/files$|, raw_path) do
      [_, _submodule_path, _sha] ->
        with {:ok, run_id} <- parse_id(id_str),
             {:ok, _run} <- RunQ.get(run_id) do
          json(conn, %{files: []})
        else
          _ -> conn |> put_status(404) |> json(%{error: "not found"})
        end

      _ ->
        conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  defp build_changes(run) do
    runs_dir = Application.get_env(:fbi, :runs_dir, "/var/lib/agent-manager/runs")
    bare_dir = WipRepo.path(runs_dir, run.id)
    branch = run.branch_name

    {commits, branch_base, gh_payload} =
      if branch do
        enrich(run, bare_dir, branch)
      else
        {[], nil, nil}
      end

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

  # Enrich the commit list and branch_base using GitHub when available,
  # falling back to the safeguard-only view when not.
  defp enrich(run, bare_dir, branch) do
    with pid when not is_nil(pid) <- run.project_id,
         {:ok, project} <- ProjQ.get(pid),
         {:ok, repo} <- GHRepo.parse(project.repo_url),
         true <- GH.available?() do
      default_branch = project.default_branch

      compare =
        case GH.compare_branch(repo, default_branch, branch) do
          {:ok, v} -> v
          _ -> %{ahead_by: 0, behind_by: 0, merge_base_sha: "", commits: []}
        end

      gh_shas = MapSet.new(compare.commits, & &1.sha)

      # Mirror branch (what the safeguard actually stores).
      mirror = "claude/run-#{run.id}"

      safeguard_branch =
        if SafeguardRepo.ref_exists?(bare_dir, branch), do: branch, else: mirror

      safeguard_commits =
        SafeguardRepo.list_commits(bare_dir, safeguard_branch, compare.merge_base_sha)

      all_commits =
        Enum.map(compare.commits, fn c ->
          Map.merge(c, %{pushed: true, files: [], files_loaded: false, submodule_bumps: []})
        end) ++
          Enum.reject(safeguard_commits, fn c -> MapSet.member?(gh_shas, c.sha) end)

      branch_base = %{base: default_branch, ahead: compare.ahead_by, behind: compare.behind_by}

      pr =
        case GH.pr_for_branch(repo, branch) do
          {:ok, v} -> v
          _ -> nil
        end

      gh_payload = %{pr: pr && Map.take(pr, [:number, :url, :state, :title]), checks: nil}

      {all_commits, branch_base, gh_payload}
    else
      _ ->
        # No GitHub access: list all safeguard commits, no ahead/behind data.
        mirror = "claude/run-#{run.id}"

        safeguard_branch =
          if SafeguardRepo.ref_exists?(bare_dir, branch), do: branch, else: mirror

        commits = SafeguardRepo.list_commits(bare_dir, safeguard_branch, "")
        {commits, nil, nil}
    end
  end

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
