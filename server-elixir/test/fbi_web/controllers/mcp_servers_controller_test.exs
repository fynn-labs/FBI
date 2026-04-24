defmodule FBIWeb.McpServersControllerTest do
  @moduledoc "Mirrors `src/server/api/mcpServers.test.ts`."
  use FBIWeb.ConnCase, async: false

  alias FBI.Mcp.Queries, as: McpQueries
  alias FBI.Projects.Queries, as: ProjectQueries

  defp make_project(attrs \\ %{}) do
    defaults = %{
      name: "mcp-ctrl-#{System.unique_integer([:positive])}",
      repo_url: "git@example.com:x/y.git"
    }

    {:ok, p} = ProjectQueries.create(Map.merge(defaults, attrs))
    p
  end

  defp json_post(conn, url, body) do
    conn
    |> put_req_header("content-type", "application/json")
    |> post(url, Jason.encode!(body))
  end

  defp json_patch(conn, url, body) do
    conn
    |> put_req_header("content-type", "application/json")
    |> patch(url, Jason.encode!(body))
  end

  describe "POST /api/mcp-servers" do
    test "creates a global server and returns 201 with body", %{conn: conn} do
      conn =
        json_post(conn, "/api/mcp-servers", %{
          name: "puppeteer",
          type: "stdio",
          command: "npx",
          args: ["-y", "@mcp/puppeteer"]
        })

      assert conn.status == 201
      body = json_response(conn, 201)
      assert body["name"] == "puppeteer"
      assert body["id"] > 0
      assert body["project_id"] == nil
      assert body["args"] == ["-y", "@mcp/puppeteer"]
    end

    test "returns 400 with error for invalid type", %{conn: conn} do
      conn =
        json_post(conn, "/api/mcp-servers", %{
          name: "bad",
          type: "websocket",
          command: "npx"
        })

      assert conn.status == 400
      assert %{"error" => _} = json_response(conn, 400)
    end
  end

  describe "GET /api/mcp-servers" do
    test "lists only global servers, excludes project-scoped rows", %{conn: conn} do
      p = make_project()

      {:ok, _} =
        McpQueries.create(%{project_id: nil, name: "fetch", type: "stdio", command: "npx"})

      {:ok, _} =
        McpQueries.create(%{project_id: p.id, name: "scoped", type: "stdio", command: "npx"})

      body = conn |> get("/api/mcp-servers") |> json_response(200)
      assert is_list(body)
      assert length(body) == 1
      assert hd(body)["name"] == "fetch"
    end
  end

  describe "PATCH /api/mcp-servers/:id" do
    test "updates a global server and returns 200 with updated row", %{conn: conn} do
      {:ok, s} =
        McpQueries.create(%{
          project_id: nil,
          name: "mem",
          type: "stdio",
          command: "npx",
          args: []
        })

      conn = json_patch(conn, "/api/mcp-servers/#{s.id}", %{args: ["-y", "updated"]})

      assert conn.status == 200
      body = json_response(conn, 200)
      assert body["args"] == ["-y", "updated"]
      assert body["id"] == s.id
    end

    test "returns 404 when id does not exist", %{conn: conn} do
      conn = json_patch(conn, "/api/mcp-servers/9999", %{args: []})
      assert conn.status == 404
    end

    test "returns 404 when row is project-scoped (cross-scope isolation)", %{conn: conn} do
      p = make_project()

      {:ok, s} =
        McpQueries.create(%{project_id: p.id, name: "scoped", type: "stdio", command: "npx"})

      conn = json_patch(conn, "/api/mcp-servers/#{s.id}", %{args: ["hacked"]})
      assert conn.status == 404
    end
  end

  describe "DELETE /api/mcp-servers/:id" do
    test "returns 204 and removes the row", %{conn: conn} do
      {:ok, s} =
        McpQueries.create(%{project_id: nil, name: "del", type: "stdio", command: "npx"})

      conn = delete(conn, "/api/mcp-servers/#{s.id}")
      assert conn.status == 204

      remaining = build_conn() |> get("/api/mcp-servers") |> json_response(200)
      refute Enum.any?(remaining, fn r -> r["id"] == s.id end)
    end

    test "returns 404 for unknown id", %{conn: conn} do
      conn = delete(conn, "/api/mcp-servers/9999")
      assert conn.status == 404
    end

    test "returns 404 for a project-scoped row", %{conn: conn} do
      p = make_project()

      {:ok, s} =
        McpQueries.create(%{project_id: p.id, name: "scoped-del", type: "stdio", command: "npx"})

      conn = delete(conn, "/api/mcp-servers/#{s.id}")
      assert conn.status == 404
    end
  end

  describe "POST /api/projects/:id/mcp-servers" do
    test "creates with project_id set and returns 201", %{conn: conn} do
      p = make_project()

      conn =
        json_post(conn, "/api/projects/#{p.id}/mcp-servers", %{
          name: "github",
          type: "stdio",
          command: "npx",
          args: []
        })

      assert conn.status == 201
      body = json_response(conn, 201)
      assert body["project_id"] == p.id
      assert body["name"] == "github"
    end
  end

  describe "GET /api/projects/:id/mcp-servers" do
    test "lists only rows matching that project_id", %{conn: conn} do
      p1 = make_project()
      p2 = make_project()
      {:ok, _} = McpQueries.create(%{project_id: nil, name: "g", type: "stdio", command: "npx"})

      {:ok, _} =
        McpQueries.create(%{project_id: p1.id, name: "p1-a", type: "stdio", command: "npx"})

      {:ok, _} =
        McpQueries.create(%{project_id: p1.id, name: "p1-b", type: "stdio", command: "npx"})

      {:ok, _} =
        McpQueries.create(%{project_id: p2.id, name: "p2-a", type: "stdio", command: "npx"})

      body = conn |> get("/api/projects/#{p1.id}/mcp-servers") |> json_response(200)
      assert is_list(body)
      names = Enum.map(body, & &1["name"])
      assert names == ["p1-a", "p1-b"]
      assert Enum.all?(body, fn r -> r["project_id"] == p1.id end)
    end
  end

  describe "PATCH /api/projects/:id/mcp-servers/:sid" do
    test "returns 404 for mismatched project", %{conn: conn} do
      p1 = make_project()
      p2 = make_project()

      {:ok, s} =
        McpQueries.create(%{project_id: p1.id, name: "gh", type: "stdio", command: "npx"})

      conn = json_patch(conn, "/api/projects/#{p2.id}/mcp-servers/#{s.id}", %{args: ["hacked"]})
      assert conn.status == 404
    end

    test "updates successfully when project matches", %{conn: conn} do
      p = make_project()

      {:ok, s} =
        McpQueries.create(%{project_id: p.id, name: "upd", type: "stdio", command: "npx"})

      conn =
        json_patch(conn, "/api/projects/#{p.id}/mcp-servers/#{s.id}", %{args: ["-y", "new"]})

      assert conn.status == 200
      body = json_response(conn, 200)
      assert body["args"] == ["-y", "new"]
      assert body["project_id"] == p.id
    end
  end

  describe "DELETE /api/projects/:id/mcp-servers/:sid" do
    test "returns 204 and removes the row when project matches", %{conn: conn} do
      p = make_project()

      {:ok, s} =
        McpQueries.create(%{project_id: p.id, name: "del", type: "stdio", command: "npx"})

      conn = delete(conn, "/api/projects/#{p.id}/mcp-servers/#{s.id}")
      assert conn.status == 204

      remaining =
        build_conn() |> get("/api/projects/#{p.id}/mcp-servers") |> json_response(200)

      refute Enum.any?(remaining, fn r -> r["id"] == s.id end)
    end

    test "returns 404 for mismatched project", %{conn: conn} do
      p1 = make_project()
      p2 = make_project()

      {:ok, s} =
        McpQueries.create(%{project_id: p1.id, name: "del2", type: "stdio", command: "npx"})

      conn = delete(conn, "/api/projects/#{p2.id}/mcp-servers/#{s.id}")
      assert conn.status == 404
    end
  end
end
