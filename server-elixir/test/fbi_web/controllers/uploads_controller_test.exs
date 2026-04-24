defmodule FBIWeb.UploadsControllerTest do
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries, as: Projects
  alias FBI.Repo
  alias FBI.Runs.Run

  setup do
    tmp = Path.join(System.tmp_dir!(), "fbi-uploads-ctrl-#{System.unique_integer([:positive])}")
    File.mkdir_p!(tmp)

    prev_runs_dir = Application.get_env(:fbi, :runs_dir)
    Application.put_env(:fbi, :runs_dir, tmp)

    on_exit(fn ->
      if prev_runs_dir do
        Application.put_env(:fbi, :runs_dir, prev_runs_dir)
      else
        Application.delete_env(:fbi, :runs_dir)
      end

      File.rm_rf(tmp)
    end)

    {:ok, runs_dir: tmp}
  end

  defp make_run(attrs \\ %{}) do
    {:ok, p} =
      Projects.create(%{
        name: "uploads-proj-#{System.unique_integer([:positive])}",
        repo_url: "git@github.com:owner/r.git",
        default_branch: "main"
      })

    defaults = %{
      project_id: p.id,
      prompt: "x",
      branch_name: "feat",
      state: "running",
      log_path: Path.join(System.tmp_dir!(), "run-log-#{System.unique_integer([:positive])}.log"),
      created_at: System.system_time(:millisecond)
    }

    Repo.insert!(struct(Run, Map.merge(defaults, attrs)))
  end

  defp make_upload(filename, contents \\ "hello") do
    src = Path.join(System.tmp_dir!(), "fbi-upload-src-#{System.unique_integer([:positive])}")
    File.write!(src, contents)
    %Plug.Upload{path: src, filename: filename, content_type: "application/octet-stream"}
  end

  # -----------------------------------------------------------------------
  # GET /api/runs/:id/uploads
  # -----------------------------------------------------------------------

  describe "GET /api/runs/:id/uploads" do
    test "404 for missing run", %{conn: conn} do
      conn = get(conn, "/api/runs/999999/uploads")
      assert conn.status == 404
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "returns empty list when uploads dir does not exist", %{conn: conn} do
      run = make_run()
      body = conn |> get("/api/runs/#{run.id}/uploads") |> json_response(200)
      assert body == %{"files" => []}
    end

    test "returns file metadata when uploads dir is populated", %{conn: conn, runs_dir: runs_dir} do
      run = make_run()
      dir = Path.join([runs_dir, Integer.to_string(run.id), "uploads"])
      File.mkdir_p!(dir)

      File.write!(Path.join(dir, "a.txt"), "abc")
      File.write!(Path.join(dir, "b.txt"), "defghij")
      # .part files are filtered out
      File.write!(Path.join(dir, "pending.part"), "xyz")

      body = conn |> get("/api/runs/#{run.id}/uploads") |> json_response(200)
      files = body["files"]

      assert length(files) == 2
      names = Enum.map(files, & &1["filename"]) |> Enum.sort()
      assert names == ["a.txt", "b.txt"]

      for f <- files do
        assert is_integer(f["size"])
        assert is_integer(f["uploaded_at"])
      end
    end
  end

  # -----------------------------------------------------------------------
  # POST /api/runs/:id/uploads
  # -----------------------------------------------------------------------

  describe "POST /api/runs/:id/uploads" do
    test "404 for missing run", %{conn: conn} do
      upload = make_upload("a.txt")
      conn = post(conn, "/api/runs/999999/uploads", %{"file" => upload})
      assert conn.status == 404
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "409 when run state is not running/waiting", %{conn: conn} do
      run = make_run(%{state: "succeeded"})
      upload = make_upload("a.txt")

      conn = post(conn, "/api/runs/#{run.id}/uploads", %{"file" => upload})
      assert conn.status == 409
      assert json_response(conn, 409) == %{"error" => "wrong_state"}
    end

    test "400 for invalid filename", %{conn: conn} do
      run = make_run()
      upload = make_upload("../evil")

      conn = post(conn, "/api/runs/#{run.id}/uploads", %{"file" => upload})
      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "invalid_filename"}
    end

    test "200 on success with expected body shape", %{
      conn: conn,
      runs_dir: runs_dir
    } do
      run = make_run()
      upload = make_upload("notes.txt", "some contents here")

      body =
        conn
        |> post("/api/runs/#{run.id}/uploads", %{"file" => upload})
        |> json_response(200)

      assert body["filename"] == "notes.txt"
      assert body["size"] == byte_size("some contents here")
      assert is_integer(body["uploaded_at"])

      # File landed on disk.
      dest = Path.join([runs_dir, Integer.to_string(run.id), "uploads", "notes.txt"])
      assert File.exists?(dest)
      assert File.read!(dest) == "some contents here"
    end

    test "also accepts state=waiting", %{conn: conn} do
      run = make_run(%{state: "waiting"})
      upload = make_upload("a.txt")
      body = conn |> post("/api/runs/#{run.id}/uploads", %{"file" => upload}) |> json_response(200)
      assert body["filename"] == "a.txt"
    end

    test "deduplicates filenames on collision", %{conn: conn, runs_dir: runs_dir} do
      run = make_run()
      dir = Path.join([runs_dir, Integer.to_string(run.id), "uploads"])
      File.mkdir_p!(dir)
      File.write!(Path.join(dir, "a.txt"), "prior")

      upload = make_upload("a.txt", "new")
      body = conn |> post("/api/runs/#{run.id}/uploads", %{"file" => upload}) |> json_response(200)
      assert body["filename"] == "a (1).txt"
    end
  end

  # -----------------------------------------------------------------------
  # DELETE /api/runs/:id/uploads/:filename
  # -----------------------------------------------------------------------

  describe "DELETE /api/runs/:id/uploads/:filename" do
    test "404 for missing run", %{conn: conn} do
      conn = delete(conn, "/api/runs/999999/uploads/a.txt")
      assert conn.status == 404
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "409 when run state is not running/waiting", %{conn: conn} do
      run = make_run(%{state: "succeeded"})
      conn = delete(conn, "/api/runs/#{run.id}/uploads/a.txt")
      assert conn.status == 409
      assert json_response(conn, 409) == %{"error" => "wrong_state"}
    end

    test "400 for invalid filename", %{conn: conn} do
      run = make_run()
      # "..evil" is the easiest form that survives URL routing while still
      # failing sanitisation ("starts with ..").
      conn = delete(conn, "/api/runs/#{run.id}/uploads/..evil")
      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "invalid_filename"}
    end

    test "404 when the file does not exist", %{conn: conn} do
      run = make_run()
      conn = delete(conn, "/api/runs/#{run.id}/uploads/missing.txt")
      assert conn.status == 404
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "204 on success", %{conn: conn, runs_dir: runs_dir} do
      run = make_run()
      dir = Path.join([runs_dir, Integer.to_string(run.id), "uploads"])
      File.mkdir_p!(dir)
      path = Path.join(dir, "victim.txt")
      File.write!(path, "bye")

      conn = delete(conn, "/api/runs/#{run.id}/uploads/victim.txt")
      assert conn.status == 204
      assert conn.resp_body == ""
      refute File.exists?(path)
    end
  end
end
