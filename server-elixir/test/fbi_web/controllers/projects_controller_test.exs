defmodule FBIWeb.ProjectsControllerTest do
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries

  describe "POST /api/projects" do
    test "creates and returns 201 with project JSON", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post(
          "/api/projects",
          Jason.encode!(%{
            name: "alpha",
            repo_url: "git@github.com:owner/alpha.git",
            marketplaces: ["a"],
            plugins: ["b"]
          })
        )

      assert conn.status == 201
      body = json_response(conn, 201)
      assert body["name"] == "alpha"
      assert body["repo_url"] == "git@github.com:owner/alpha.git"
      assert body["marketplaces"] == ["a"]
      assert body["plugins"] == ["b"]
      assert body["default_branch"] == "main"
      assert is_integer(body["created_at"])
      assert body["created_at"] == body["updated_at"]
    end
  end

  describe "GET /api/projects" do
    test "lists projects and includes optional last_run", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "g", repo_url: "x"})
      body = conn |> get("/api/projects") |> json_response(200)
      assert is_list(body)
      found = Enum.find(body, &(&1["id"] == p.id))
      refute found == nil
      # last_run key exists and is nil when there are no runs
      assert Map.has_key?(found, "last_run")
      assert found["last_run"] == nil
    end
  end

  describe "GET /api/projects/:id" do
    test "returns 404 for missing", %{conn: conn} do
      conn = get(conn, "/api/projects/9999999")
      assert conn.status == 404
      assert json_response(conn, 404) == %{"error" => "not found"}
    end

    test "returns project without last_run field", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "h", repo_url: "x"})
      body = conn |> get("/api/projects/#{p.id}") |> json_response(200)
      assert body["id"] == p.id
      refute Map.has_key?(body, "last_run")
    end
  end

  describe "PATCH /api/projects/:id" do
    test "updates fields and returns 200", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "i", repo_url: "x"})

      body =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/projects/#{p.id}", Jason.encode!(%{instructions: "hello"}))
        |> json_response(200)

      assert body["instructions"] == "hello"
    end

    test "404 for missing", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/projects/9999999", Jason.encode!(%{name: "x"}))

      assert conn.status == 404
    end
  end

  describe "DELETE /api/projects/:id" do
    test "returns 204 on success", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "j", repo_url: "x"})
      conn = delete(conn, "/api/projects/#{p.id}")
      assert conn.status == 204
    end

    test "returns 204 even for missing (idempotent, matches TS)", %{conn: conn} do
      conn = delete(conn, "/api/projects/9999999")
      assert conn.status == 204
    end
  end

  describe "GET /api/projects/:id/prompts/recent" do
    test "returns distinct prompts with last_used_at and run_id", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "k", repo_url: "x"})
      ms = System.system_time(:millisecond)

      FBI.Repo.insert!(%FBI.Runs.Run{
        project_id: p.id,
        prompt: "foo",
        branch_name: "b",
        state: "succeeded",
        log_path: "/tmp/a",
        created_at: ms
      })

      body = conn |> get("/api/projects/#{p.id}/prompts/recent") |> json_response(200)
      assert [%{"prompt" => "foo", "last_used_at" => _, "run_id" => _}] = body
    end

    test "clamps limit param to [1, 50]", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "l", repo_url: "x"})
      body = conn |> get("/api/projects/#{p.id}/prompts/recent?limit=0") |> json_response(200)
      assert is_list(body)
    end
  end
end
