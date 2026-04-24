defmodule FBIWeb.TranscriptControllerTest do
  @moduledoc "Mirrors the transcript slice of the TS `/api/runs/:id/transcript` contract."
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries, as: ProjectsQueries
  alias FBI.Repo
  alias FBI.Runs.Run

  setup do
    {:ok, p} =
      ProjectsQueries.create(%{
        name: "transcript-ctrl-#{System.unique_integer([:positive])}",
        repo_url: "git@example.com:x/y.git"
      })

    %{project_id: p.id}
  end

  defp make_run(project_id, log_path) do
    Repo.insert!(%Run{
      project_id: project_id,
      prompt: "p",
      branch_name: "b",
      state: "succeeded",
      log_path: log_path,
      created_at: System.system_time(:millisecond)
    })
  end

  test "404 for missing run id", %{conn: conn} do
    conn = get(conn, "/api/runs/9999999/transcript")
    assert conn.status == 404
  end

  test "200 with empty body for run whose log file does not exist", %{
    conn: conn,
    project_id: pid
  } do
    missing = "/tmp/does-not-exist-#{System.unique_integer([:positive])}.log"
    r = make_run(pid, missing)

    conn = get(conn, "/api/runs/#{r.id}/transcript")
    assert conn.status == 200
    assert conn.resp_body == ""

    assert Enum.member?(
             Plug.Conn.get_resp_header(conn, "content-type"),
             "text/plain; charset=utf-8"
           )
  end

  test "200 with file contents when log file exists", %{conn: conn, project_id: pid} do
    tmp = Path.join(System.tmp_dir!(), "transcript-#{System.unique_integer([:positive])}.log")
    File.write!(tmp, "hello\n")

    r = make_run(pid, tmp)

    conn = get(conn, "/api/runs/#{r.id}/transcript")
    assert conn.status == 200
    assert conn.resp_body == "hello\n"

    assert Enum.member?(
             Plug.Conn.get_resp_header(conn, "content-type"),
             "text/plain; charset=utf-8"
           )

    File.rm(tmp)
  end
end
