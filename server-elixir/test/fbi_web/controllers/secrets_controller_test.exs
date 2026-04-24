defmodule FBIWeb.SecretsControllerTest do
  @moduledoc "Mirrors `src/server/api/secrets.test.ts`."
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries

  setup do
    key_path = Path.join(System.tmp_dir!(), "fbi-secret-ctrl-#{System.unique_integer([:positive])}")
    File.write!(key_path, :crypto.strong_rand_bytes(32))
    prev = Application.get_env(:fbi, :secrets_key_path)
    Application.put_env(:fbi, :secrets_key_path, key_path)

    on_exit(fn ->
      if prev, do: Application.put_env(:fbi, :secrets_key_path, prev), else: Application.delete_env(:fbi, :secrets_key_path)
      File.rm(key_path)
    end)

    {:ok, p} = Queries.create(%{name: "sc#{System.unique_integer([:positive])}", repo_url: "x"})
    %{project_id: p.id}
  end

  describe "PUT /api/projects/:id/secrets/:name" do
    test "creates and returns 204", %{conn: conn, project_id: pid} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> put("/api/projects/#{pid}/secrets/FOO", Jason.encode!(%{value: "secret-value"}))

      assert conn.status == 204
    end

    test "returns 400 when value missing", %{conn: conn, project_id: pid} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> put("/api/projects/#{pid}/secrets/FOO", Jason.encode!(%{}))

      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "value required"}
    end
  end

  describe "GET /api/projects/:id/secrets" do
    test "returns list of names only, no values", %{conn: conn, project_id: pid} do
      conn
      |> put_req_header("content-type", "application/json")
      |> put("/api/projects/#{pid}/secrets/ALPHA", Jason.encode!(%{value: "alpha-val"}))

      list_conn = build_conn() |> get("/api/projects/#{pid}/secrets")
      body = json_response(list_conn, 200)
      assert is_list(body)
      [%{"name" => "ALPHA", "created_at" => _}] = body
      refute Map.has_key?(hd(body), "value")
      refute Map.has_key?(hd(body), "value_enc")
    end

    test "returns empty list for project without secrets", %{conn: conn, project_id: pid} do
      assert conn |> get("/api/projects/#{pid}/secrets") |> json_response(200) == []
    end
  end

  describe "DELETE /api/projects/:id/secrets/:name" do
    test "returns 204 and removes secret", %{conn: conn, project_id: pid} do
      conn
      |> put_req_header("content-type", "application/json")
      |> put("/api/projects/#{pid}/secrets/DELME", Jason.encode!(%{value: "x"}))

      del_conn = build_conn() |> delete("/api/projects/#{pid}/secrets/DELME")
      assert del_conn.status == 204

      list = build_conn() |> get("/api/projects/#{pid}/secrets") |> json_response(200)
      assert list == []
    end

    test "returns 204 even for missing secret (idempotent, matches TS)", %{
      conn: conn,
      project_id: pid
    } do
      conn = delete(conn, "/api/projects/#{pid}/secrets/NONEXISTENT")
      assert conn.status == 204
    end
  end
end
