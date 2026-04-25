defmodule FBIWeb.ProxyControllerTest do
  use FBIWeb.ConnCase, async: false

  test "GET /api/runs/:id/listening-ports returns 404 for unknown run", %{conn: conn} do
    conn = get(conn, ~p"/api/runs/999999/listening-ports")
    assert json_response(conn, 404)
  end

  test "GET /api/runs/:id/listening-ports returns 409 when run has no container", %{conn: conn} do
    {:ok, p} =
      FBI.Projects.Queries.create(%{
        name: "p-#{System.unique_integer([:positive])}",
        repo_url: "git@github.com:o/r.git",
        default_branch: "main"
      })

    %FBI.Runs.Run{
      project_id: p.id,
      prompt: "x",
      branch_name: "feat",
      state: "succeeded",
      log_path: "/tmp/x.log",
      created_at: System.system_time(:millisecond),
      state_entered_at: System.system_time(:millisecond)
    }
    |> FBI.Repo.insert!()

    last_id = FBI.Repo.aggregate(FBI.Runs.Run, :max, :id)
    conn = get(conn, ~p"/api/runs/#{last_id}/listening-ports")
    assert json_response(conn, 409)
  end
end
