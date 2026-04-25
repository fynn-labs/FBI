defmodule FBIWeb.ChangesControllerTest do
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries, as: ProjectsQueries
  alias FBI.Repo
  alias FBI.Runs.Run

  setup do
    {:ok, project} =
      ProjectsQueries.create(%{
        name: "test-changes-#{System.unique_integer([:positive])}",
        repo_url: "git@github.com:org/repo.git",
        default_branch: "main"
      })

    run =
      Repo.insert!(
        struct(Run, %{
          project_id: project.id,
          prompt: "p",
          branch_name: "claude/run-1",
          state: "succeeded",
          log_path: "/tmp/r_#{System.unique_integer([:positive])}.log",
          created_at: System.os_time(:millisecond),
          kind: "work"
        })
      )

    {:ok, run_id: run.id, project: project}
  end

  describe "GET /api/runs/:id/changes" do
    test "returns empty changes for a run with no wip repo", %{conn: conn, run_id: run_id} do
      conn = get(conn, "/api/runs/#{run_id}/changes")
      assert conn.status == 200
      body = json_response(conn, 200)
      assert is_list(body["commits"])
      assert body["uncommitted"] == []
    end

    test "returns 404 for missing run", %{conn: conn} do
      conn = get(conn, "/api/runs/99999/changes")
      assert conn.status == 404
    end
  end

  describe "GET /api/runs/:id/commits/:sha/files" do
    test "returns empty files for unknown sha", %{conn: conn, run_id: run_id} do
      conn = get(conn, "/api/runs/#{run_id}/commits/aabbccdd/files")
      assert conn.status == 200
      body = json_response(conn, 200)
      assert body["files"] == []
    end
  end

  describe "GET /api/runs/:id/submodule/*path" do
    test "returns 404 for run-not-found", %{conn: conn} do
      # Stable smoke test: hits the route, confirms no crash, asserts 404 because run doesn't exist.
      conn = get(conn, "/api/runs/9999999/submodule/foo/bar/commits/abcdef0/files")
      assert response(conn, 404)
    end

    test "returns 400 for path traversal attempts", %{conn: conn, run_id: run_id} do
      # Run a real request through the route; validates list->string normalization works.
      # If the list normalization were missing, this would 500 with FunctionClauseError instead of 400.
      # The %2F (URL-encoded /) keeps `..` inside a single segment so it survives to the body check.
      conn = get(conn, "/api/runs/#{run_id}/submodule/..%2Fevil/commits/abcdef0/files")
      assert response(conn, 400)
    end
  end

  describe "controller source contract" do
    test "build_changes uses GH compare_branch for branch-unique commits" do
      src = File.read!("lib/fbi_web/controllers/changes_controller.ex")
      assert src =~ "GH.compare_branch"
      refute src =~ "GH.commits_on_branch"
    end

    test "controller emits branch_base with base/ahead/behind keys (TS parity)" do
      src = File.read!("lib/fbi_web/controllers/changes_controller.ex")
      # Negative test: the old wrong shape must not be present.
      refute src =~ ~r/ahead_by:\s*ahead_by/
      # Positive test: the right shape is.
      assert src =~ ~r/branch_base\s*=\s*%\{base:\s*base_branch/
    end

    test "commit_files attempts docker exec before falling back to gh" do
      src = File.read!("lib/fbi_web/controllers/changes_controller.ex")
      assert src =~ "Docker.exec_create"
    end

    test "submodule_files exits the always-empty stub" do
      src = File.read!("lib/fbi_web/controllers/changes_controller.ex")
      refute src =~ ~r/submodule_files.*?json\(conn,\s*%\{files:\s*\[\]\}\)/s
    end
  end
end
