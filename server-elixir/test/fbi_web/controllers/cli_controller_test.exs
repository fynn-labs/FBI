defmodule FBIWeb.CliControllerTest do
  @moduledoc """
  Mirrors `src/server/api/cli.test.ts`.  Contract: allow-list `os` ∈
  {darwin, linux} and `arch` ∈ {amd64, arm64}; stream
  `{cli_dist_dir}/fbi-tunnel-{os}-{arch}` with the right headers; 400 on
  bad os/arch; 503 when the file is missing; include
  `X-FBI-CLI-Version` header only when the app-env value is non-nil.
  """

  use FBIWeb.ConnCase, async: false

  setup do
    # Use a unique tempdir per test so parallel test runs (if they happen in
    # the future) do not trip over each other.  We still run async:false
    # above because app-env mutation is process-global.
    dir = Path.join(System.tmp_dir!(), "fbi-cli-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)

    prev_dir = Application.get_env(:fbi, :cli_dist_dir)
    prev_ver = Application.get_env(:fbi, :fbi_cli_version)
    Application.put_env(:fbi, :cli_dist_dir, dir)

    on_exit(fn ->
      Application.put_env(:fbi, :cli_dist_dir, prev_dir)
      Application.put_env(:fbi, :fbi_cli_version, prev_ver)
      File.rm_rf!(dir)
    end)

    %{dir: dir}
  end

  test "streams the binary with the right headers", %{conn: conn, dir: dir} do
    File.write!(Path.join(dir, "fbi-tunnel-darwin-arm64"), "BINARY_CONTENTS")
    Application.put_env(:fbi, :fbi_cli_version, "abc1234")

    conn = get(conn, "/api/cli/fbi-tunnel/darwin/arm64")
    assert conn.status == 200
    assert get_resp_header(conn, "content-type") == ["application/octet-stream"]

    assert get_resp_header(conn, "content-disposition") == [
             ~s(attachment; filename="fbi-tunnel-darwin-arm64")
           ]

    assert get_resp_header(conn, "cache-control") == ["public, max-age=3600"]
    assert get_resp_header(conn, "x-fbi-cli-version") == ["abc1234"]
    assert conn.resp_body == "BINARY_CONTENTS"
  end

  test "omits X-FBI-CLI-Version when version is unset", %{conn: conn, dir: dir} do
    File.write!(Path.join(dir, "fbi-tunnel-linux-amd64"), "X")
    Application.put_env(:fbi, :fbi_cli_version, nil)

    conn = get(conn, "/api/cli/fbi-tunnel/linux/amd64")
    assert conn.status == 200
    assert get_resp_header(conn, "x-fbi-cli-version") == []
  end

  test "returns 400 for an unsupported os", %{conn: conn} do
    conn = get(conn, "/api/cli/fbi-tunnel/windows/amd64")
    assert conn.status == 400
    assert json_response(conn, 400) == %{"error" => "unsupported os/arch"}
  end

  test "returns 400 for an unsupported arch", %{conn: conn} do
    conn = get(conn, "/api/cli/fbi-tunnel/linux/riscv")
    assert conn.status == 400
    assert json_response(conn, 400) == %{"error" => "unsupported os/arch"}
  end

  test "returns 503 when the binary file is missing", %{conn: conn} do
    conn = get(conn, "/api/cli/fbi-tunnel/darwin/arm64")
    assert conn.status == 503

    assert json_response(conn, 503) == %{
             "error" => "fbi-tunnel binary not built; rerun npm run build"
           }
  end

  test "rejects path-traversal attempts via the os allow-list", %{conn: conn} do
    # Phoenix path parsing may or may not reach the handler with this URL;
    # either 400 (handler rejects) or 404 (router rejects) is acceptable.
    # The invariant is that no 200 is ever returned for such URLs.
    conn = get(conn, "/api/cli/fbi-tunnel/..%2Fetc/amd64")
    assert conn.status in [400, 404]
  end
end
