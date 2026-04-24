defmodule FBIWeb.GithubControllerTest do
  @moduledoc """
  Covers GET /api/runs/:id/github, POST /api/runs/:id/github/pr, and
  POST /api/runs/:id/github/merge via the stubbed `:gh_cmd_adapter`.
  """
  use FBIWeb.ConnCase, async: false

  alias FBI.Github.StatusCache
  alias FBI.Projects.Queries, as: ProjectsQueries
  alias FBI.Repo
  alias FBI.Runs.Run

  setup do
    prev = Application.get_env(:fbi, :gh_cmd_adapter)

    on_exit(fn ->
      if prev do
        Application.put_env(:fbi, :gh_cmd_adapter, prev)
      else
        Application.delete_env(:fbi, :gh_cmd_adapter)
      end
    end)

    :ok
  end

  defp make_project(attrs \\ %{}) do
    defaults = %{
      name: "gh-ctrl-#{System.unique_integer([:positive])}",
      repo_url: "git@github.com:owner/repo.git",
      default_branch: "main"
    }

    {:ok, p} = ProjectsQueries.create(Map.merge(defaults, attrs))
    p
  end

  defp make_run(project_id, attrs \\ %{}) do
    defaults = %{
      project_id: project_id,
      prompt: "hello world",
      branch_name: "feature/branch",
      state: "succeeded",
      log_path: "/tmp/gh-log-#{System.unique_integer([:positive])}.log",
      created_at: System.system_time(:millisecond)
    }

    Repo.insert!(struct(Run, Map.merge(defaults, attrs)))
  end

  defp json_post(conn, url) do
    conn
    |> put_req_header("content-type", "application/json")
    |> post(url, "{}")
  end

  describe "GET /api/runs/:id/github" do
    test "404 for missing run", %{conn: conn} do
      conn = get(conn, "/api/runs/9999999/github")
      assert conn.status == 404
    end

    test "returns github_available: false when repo URL is not GitHub", %{conn: conn} do
      p = make_project(%{repo_url: "git@gitlab.com:a/b.git"})
      r = make_run(p.id)
      StatusCache.invalidate(r.id)

      body = conn |> get("/api/runs/#{r.id}/github") |> json_response(200)
      assert body["github_available"] == false
      assert body["pr"] == nil
      assert body["commits"] == []
    end

    test "cache hit skips the adapter", %{conn: conn} do
      p = make_project()
      r = make_run(p.id)
      StatusCache.invalidate(r.id)

      # First call: adapter returns an empty PR list + no checks + no commits.
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:ok, "[]"} end)
      _ = conn |> get("/api/runs/#{r.id}/github") |> json_response(200)

      # Second call: adapter raises if invoked. Cache should short-circuit.
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        raise "adapter should not be called on cache hit"
      end)

      body = conn |> get("/api/runs/#{r.id}/github") |> json_response(200)
      assert body["github_available"] == true
    end

    test "normal success path returns PR + checks + commits", %{conn: conn} do
      p = make_project()
      r = make_run(p.id)
      StatusCache.invalidate(r.id)

      Application.put_env(:fbi, :gh_cmd_adapter, fn args ->
        cond do
          Enum.member?(args, "pr") and Enum.member?(args, "list") ->
            {:ok,
             Jason.encode!([
               %{"number" => 7, "url" => "https://x/7", "state" => "OPEN", "title" => "t"}
             ])}

          Enum.member?(args, "checks") ->
            {:ok,
             Jason.encode!([
               %{"name" => "ci", "status" => "completed", "conclusion" => "success"}
             ])}

          Enum.member?(args, "api") ->
            {:ok,
             Jason.encode!([
               %{
                 "sha" => "abc",
                 "commit" => %{
                   "message" => "subj\nbody",
                   "committer" => %{"date" => "2026-04-24T00:00:00Z"}
                 }
               }
             ])}

          true ->
            {:ok, "[]"}
        end
      end)

      body = conn |> get("/api/runs/#{r.id}/github") |> json_response(200)
      assert body["github_available"] == true
      assert body["pr"]["number"] == 7
      assert body["checks"]["total"] == 1
      assert body["checks"]["state"] == "success"
      assert [%{"sha" => "abc", "subject" => "subj"}] = body["commits"]
    end
  end

  describe "POST /api/runs/:id/github/pr" do
    test "400 without branch_name", %{conn: conn} do
      p = make_project()
      r = make_run(p.id, %{branch_name: ""})

      body = conn |> json_post("/api/runs/#{r.id}/github/pr") |> json_response(400)
      assert body["error"] =~ "no branch"
    end

    test "400 for non-github project", %{conn: conn} do
      p = make_project(%{repo_url: "not-a-url"})
      r = make_run(p.id)

      body = conn |> json_post("/api/runs/#{r.id}/github/pr") |> json_response(400)
      assert body["error"] == "not a github project"
    end

    test "409 when PR already exists", %{conn: conn} do
      p = make_project()
      r = make_run(p.id)

      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        {:ok,
         Jason.encode!([
           %{"number" => 1, "url" => "u", "state" => "OPEN", "title" => "t"}
         ])}
      end)

      resp = conn |> json_post("/api/runs/#{r.id}/github/pr")
      assert resp.status == 409
      body = json_response(resp, 409)
      assert body["pr"]["number"] == 1
    end

    test "200 with PR JSON on success", %{conn: conn} do
      p = make_project()
      r = make_run(p.id)

      # The controller calls pr_for_branch (returns []), then pr create
      # (success stdout is fine), then pr_for_branch again for the PR object.
      counter = :counters.new(1, [])

      Application.put_env(:fbi, :gh_cmd_adapter, fn args ->
        :counters.add(counter, 1, 1)
        n = :counters.get(counter, 1)

        cond do
          n == 1 and Enum.member?(args, "list") ->
            {:ok, "[]"}

          Enum.member?(args, "create") ->
            {:ok, "https://github.com/owner/repo/pull/42"}

          Enum.member?(args, "list") ->
            {:ok,
             Jason.encode!([
               %{"number" => 42, "url" => "u", "state" => "OPEN", "title" => "t"}
             ])}

          true ->
            {:ok, "[]"}
        end
      end)

      body = conn |> json_post("/api/runs/#{r.id}/github/pr") |> json_response(200)
      assert body["number"] == 42
      assert body["state"] == "OPEN"
    end
  end

  describe "POST /api/runs/:id/github/merge" do
    test "400 with reason: no-branch when branch_name is empty", %{conn: conn} do
      p = make_project()
      r = make_run(p.id, %{branch_name: ""})

      body = conn |> json_post("/api/runs/#{r.id}/github/merge") |> json_response(400)
      assert body["merged"] == false
      assert body["reason"] == "no-branch"
    end

    test "400 with reason: not-github for non-github project", %{conn: conn} do
      p = make_project(%{repo_url: "git@gitlab.com:a/b.git"})
      r = make_run(p.id)

      body = conn |> json_post("/api/runs/#{r.id}/github/merge") |> json_response(400)
      assert body["merged"] == false
      assert body["reason"] == "not-github"
    end

    test "200 merged: true on success", %{conn: conn} do
      p = make_project()
      r = make_run(p.id)

      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        {:ok, Jason.encode!(%{"sha" => "merged-sha"})}
      end)

      body = conn |> json_post("/api/runs/#{r.id}/github/merge") |> json_response(200)
      assert body["merged"] == true
      assert body["sha"] == "merged-sha"
    end

    test "200 merged: false, reason: already-merged on empty stdout", %{conn: conn} do
      p = make_project()
      r = make_run(p.id)

      Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:ok, ""} end)

      body = conn |> json_post("/api/runs/#{r.id}/github/merge") |> json_response(200)
      assert body["merged"] == false
      assert body["reason"] == "already-merged"
    end

    test "409 merged: false, reason: conflict when adapter returns conflict", %{conn: conn} do
      p = make_project()
      r = make_run(p.id)

      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        {:error, {1, "merge conflict occurred"}}
      end)

      resp = conn |> json_post("/api/runs/#{r.id}/github/merge")
      assert resp.status == 409
      body = json_response(resp, 409)
      assert body["merged"] == false
      assert body["reason"] == "conflict"
    end

    test "500 merged: false, reason: gh-error on other gh errors", %{conn: conn} do
      p = make_project()
      r = make_run(p.id)

      Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:error, {2, "network"}} end)

      resp = conn |> json_post("/api/runs/#{r.id}/github/merge")
      assert resp.status == 500
      body = json_response(resp, 500)
      assert body["merged"] == false
      assert body["reason"] == "gh-error"
    end
  end
end
