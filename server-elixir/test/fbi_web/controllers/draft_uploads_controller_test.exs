defmodule FBIWeb.DraftUploadsControllerTest do
  use FBIWeb.ConnCase, async: false

  setup do
    tmp = Path.join(System.tmp_dir!(), "fbi-drafts-ctrl-#{System.unique_integer([:positive])}")
    File.mkdir_p!(tmp)

    prev = Application.get_env(:fbi, :draft_uploads_dir)
    Application.put_env(:fbi, :draft_uploads_dir, tmp)

    on_exit(fn ->
      if prev do
        Application.put_env(:fbi, :draft_uploads_dir, prev)
      else
        Application.delete_env(:fbi, :draft_uploads_dir)
      end

      File.rm_rf(tmp)
    end)

    {:ok, drafts_dir: tmp}
  end

  defp make_upload(filename, contents \\ "hello") do
    src = Path.join(System.tmp_dir!(), "fbi-draft-src-#{System.unique_integer([:positive])}")
    File.write!(src, contents)
    %Plug.Upload{path: src, filename: filename, content_type: "application/octet-stream"}
  end

  # -----------------------------------------------------------------------
  # POST /api/draft-uploads
  # -----------------------------------------------------------------------

  describe "POST /api/draft-uploads" do
    test "creates a new token directory when no draft_token is provided", %{
      conn: conn,
      drafts_dir: drafts_dir
    } do
      upload = make_upload("foo.txt", "hello world")
      body = conn |> post("/api/draft-uploads", %{"file" => upload}) |> json_response(200)

      assert is_binary(body["draft_token"])
      assert Regex.match?(~r/^[0-9a-f]{32}$/, body["draft_token"])
      assert body["filename"] == "foo.txt"
      assert body["size"] == byte_size("hello world")
      assert is_integer(body["uploaded_at"])

      dest = Path.join([drafts_dir, body["draft_token"], "foo.txt"])
      assert File.exists?(dest)
      assert File.read!(dest) == "hello world"
    end

    test "400 when draft_token query param is not 32-char hex", %{conn: conn} do
      upload = make_upload("foo.txt")
      conn = post(conn, "/api/draft-uploads?draft_token=nope", %{"file" => upload})
      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "invalid_token"}
    end

    test "reuses a valid draft_token and deduplicates identical filenames", %{
      conn: conn,
      drafts_dir: drafts_dir
    } do
      token = String.duplicate("a", 32)
      dir = Path.join(drafts_dir, token)
      File.mkdir_p!(dir)
      File.write!(Path.join(dir, "foo.txt"), "prior")

      upload = make_upload("foo.txt", "new")

      body =
        conn
        |> post("/api/draft-uploads?draft_token=#{token}", %{"file" => upload})
        |> json_response(200)

      assert body["draft_token"] == token
      assert body["filename"] == "foo (1).txt"

      assert File.read!(Path.join(dir, "foo.txt")) == "prior"
      assert File.read!(Path.join(dir, "foo (1).txt")) == "new"
    end

    test "400 for invalid filename", %{conn: conn} do
      upload = make_upload("../../etc/passwd")
      conn = post(conn, "/api/draft-uploads", %{"file" => upload})
      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "invalid_filename"}
    end
  end

  # -----------------------------------------------------------------------
  # DELETE /api/draft-uploads/:token/:filename
  # -----------------------------------------------------------------------

  describe "DELETE /api/draft-uploads/:token/:filename" do
    test "400 for invalid token", %{conn: conn} do
      conn = delete(conn, "/api/draft-uploads/not-a-token/foo.txt")
      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "invalid_token"}
    end

    test "400 for invalid filename", %{conn: conn} do
      token = String.duplicate("a", 32)
      conn = delete(conn, "/api/draft-uploads/#{token}/..evil")
      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "invalid_filename"}
    end

    test "404 for nonexistent file", %{conn: conn} do
      token = String.duplicate("a", 32)
      conn = delete(conn, "/api/draft-uploads/#{token}/missing.txt")
      assert conn.status == 404
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "204 on success", %{conn: conn, drafts_dir: drafts_dir} do
      token = String.duplicate("a", 32)
      dir = Path.join(drafts_dir, token)
      File.mkdir_p!(dir)
      path = Path.join(dir, "foo.txt")
      File.write!(path, "bye")

      conn = delete(conn, "/api/draft-uploads/#{token}/foo.txt")
      assert conn.status == 204
      assert conn.resp_body == ""
      refute File.exists?(path)
    end
  end
end
