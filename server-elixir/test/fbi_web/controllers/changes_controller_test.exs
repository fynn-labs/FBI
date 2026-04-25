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

  describe "controller source contract" do
    test "build_changes uses GH compare_branch for branch-unique commits" do
      src = File.read!("lib/fbi_web/controllers/changes_controller.ex")
      assert src =~ "GH.compare_branch"
      refute src =~ "GH.commits_on_branch"
    end
  end
end
