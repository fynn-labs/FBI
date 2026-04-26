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

  defp tmp_log(content) do
    path = Path.join(System.tmp_dir!(), "transcript-#{System.unique_integer([:positive])}.log")
    File.write!(path, content)
    path
  end

  test "404 for missing run id", %{conn: conn} do
    conn = get(conn, "/api/runs/9999999/transcript")
    assert conn.status == 404
  end

  test "200 with empty body and X-Transcript-Total: 0 for missing log file", %{
    conn: conn,
    project_id: pid
  } do
    missing = "/tmp/does-not-exist-#{System.unique_integer([:positive])}.log"
    r = make_run(pid, missing)

    conn = get(conn, "/api/runs/#{r.id}/transcript")
    assert conn.status == 200
    assert conn.resp_body == ""
    assert Plug.Conn.get_resp_header(conn, "x-transcript-total") == ["0"]
    assert "text/plain; charset=utf-8" in Plug.Conn.get_resp_header(conn, "content-type")
  end

  test "200 with file contents and correct X-Transcript-Total when no Range header", %{
    conn: conn,
    project_id: pid
  } do
    content = "hello\n"
    path = tmp_log(content)
    r = make_run(pid, path)

    conn = get(conn, "/api/runs/#{r.id}/transcript")
    assert conn.status == 200
    assert conn.resp_body == content

    assert Plug.Conn.get_resp_header(conn, "x-transcript-total") == [
             Integer.to_string(byte_size(content))
           ]

    assert "text/plain; charset=utf-8" in Plug.Conn.get_resp_header(conn, "content-type")

    File.rm(path)
  end

  test "206 with byte slice when valid Range header is present", %{conn: conn, project_id: pid} do
    content = "abcdefghij"
    path = tmp_log(content)
    r = make_run(pid, path)

    conn =
      conn
      |> put_req_header("range", "bytes=0-0")
      |> get("/api/runs/#{r.id}/transcript")

    assert conn.status == 206
    assert conn.resp_body == "a"
    assert Plug.Conn.get_resp_header(conn, "x-transcript-total") == ["10"]
    assert Plug.Conn.get_resp_header(conn, "content-range") == ["bytes 0-0/10"]

    File.rm(path)
  end

  test "206 with tail slice via open-ended Range", %{conn: conn, project_id: pid} do
    content = "abcdefghij"
    path = tmp_log(content)
    r = make_run(pid, path)

    conn =
      conn
      |> put_req_header("range", "bytes=5-")
      |> get("/api/runs/#{r.id}/transcript")

    assert conn.status == 206
    assert conn.resp_body == "fghij"
    assert Plug.Conn.get_resp_header(conn, "content-range") == ["bytes 5-9/10"]
    # Non-zero start: x-transcript-mode-prefix-bytes header must be present.
    [prefix_str] = Plug.Conn.get_resp_header(conn, "x-transcript-mode-prefix-bytes")
    assert String.match?(prefix_str, ~r/^\d+$/)

    File.rm(path)
  end

  test "bytes=0-N range: no x-transcript-mode-prefix-bytes header", %{
    conn: conn,
    project_id: pid
  } do
    content = "abcdefghijklmnopqrstuvwxyz"
    path = tmp_log(content)
    r = make_run(pid, path)

    conn =
      conn
      |> put_req_header("range", "bytes=0-100")
      |> get("/api/runs/#{r.id}/transcript")

    assert conn.status == 206
    assert byte_size(conn.resp_body) == min(101, byte_size(content))
    assert Plug.Conn.get_resp_header(conn, "x-transcript-mode-prefix-bytes") == []

    File.rm(path)
  end

  test "bytes=N-M (non-zero start): x-transcript-mode-prefix-bytes header present", %{
    conn: conn,
    project_id: pid
  } do
    # Write at least 201 bytes so range 100-200 is valid.
    content = String.duplicate("x", 300)
    path = tmp_log(content)
    r = make_run(pid, path)

    conn =
      conn
      |> put_req_header("range", "bytes=100-200")
      |> get("/api/runs/#{r.id}/transcript")

    assert conn.status == 206

    [prefix_str] = Plug.Conn.get_resp_header(conn, "x-transcript-mode-prefix-bytes")
    prefix_bytes = String.to_integer(prefix_str)
    # Body must be prefix + 101 bytes of content (bytes 100..200 inclusive).
    assert byte_size(conn.resp_body) == prefix_bytes + 101

    File.rm(path)
  end

  test "bytes=0- open-ended from zero: no x-transcript-mode-prefix-bytes header", %{
    conn: conn,
    project_id: pid
  } do
    content = "hello world"
    path = tmp_log(content)
    r = make_run(pid, path)

    conn =
      conn
      |> put_req_header("range", "bytes=0-")
      |> get("/api/runs/#{r.id}/transcript")

    assert conn.status == 206
    assert Plug.Conn.get_resp_header(conn, "x-transcript-mode-prefix-bytes") == []

    File.rm(path)
  end

  test "416 when Range start is beyond file size", %{conn: conn, project_id: pid} do
    content = "hi"
    path = tmp_log(content)
    r = make_run(pid, path)

    conn =
      conn
      |> put_req_header("range", "bytes=99-200")
      |> get("/api/runs/#{r.id}/transcript")

    assert conn.status == 416
    assert Plug.Conn.get_resp_header(conn, "content-range") == ["bytes */#{byte_size(content)}"]

    File.rm(path)
  end
end
