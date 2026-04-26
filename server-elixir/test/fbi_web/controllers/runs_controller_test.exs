defmodule FBIWeb.RunsControllerTest do
  @moduledoc "Mirrors the read/patch/delete slice of `src/server/api/runs.test.ts`."
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries, as: ProjectsQueries
  alias FBI.Repo
  alias FBI.Runs.Run

  setup do
    # Make FBI.Docker.kill fail softly so the DELETE active-run path doesn't
    # depend on an actual Docker daemon.
    Application.put_env(:fbi, :docker_socket_path, "/nonexistent/sock")

    {:ok, p} =
      ProjectsQueries.create(%{
        name: "runs-ctrl-#{System.unique_integer([:positive])}",
        repo_url: "git@example.com:x/y.git"
      })

    %{project_id: p.id}
  end

  defp make_run(project_id, attrs \\ %{}) do
    defaults = %{
      project_id: project_id,
      prompt: "hello world",
      branch_name: "b",
      state: "succeeded",
      log_path: "/tmp/log-#{System.unique_integer([:positive])}.log",
      created_at: System.system_time(:millisecond)
    }

    Repo.insert!(struct(Run, Map.merge(defaults, attrs)))
  end

  defp json_patch(conn, url, body) do
    conn
    |> put_req_header("content-type", "application/json")
    |> patch(url, Jason.encode!(body))
  end

  describe "GET /api/runs" do
    test "returns an array when no paging params", %{conn: conn, project_id: pid} do
      _ = make_run(pid)
      body = conn |> get("/api/runs") |> json_response(200)
      assert is_list(body)
      assert length(body) >= 1
    end

    test "returns %{items, total} shape when limit provided", %{conn: conn, project_id: pid} do
      Enum.each(1..3, fn _ -> make_run(pid) end)
      body = conn |> get("/api/runs?limit=10") |> json_response(200)
      assert %{"items" => items, "total" => total} = body
      assert is_list(items)
      assert is_integer(total)
      assert total >= 3
    end

    test "filters by state", %{conn: conn, project_id: pid} do
      _ = make_run(pid, %{state: "succeeded"})
      _ = make_run(pid, %{state: "failed"})
      body = conn |> get("/api/runs?state=failed") |> json_response(200)
      assert is_list(body)
      assert Enum.all?(body, &(&1["state"] == "failed"))
      assert Enum.any?(body, &(&1["state"] == "failed"))
    end

    test "filters by q case-insensitively", %{conn: conn, project_id: pid} do
      _ = make_run(pid, %{prompt: "HELLO World"})
      _ = make_run(pid, %{prompt: "other prompt"})
      body = conn |> get("/api/runs?q=hello") |> json_response(200)
      assert is_list(body)
      assert Enum.any?(body, &(&1["prompt"] == "HELLO World"))
      refute Enum.any?(body, &(&1["prompt"] == "other prompt"))
    end
  end

  describe "GET /api/runs/:id" do
    test "returns 404 for missing", %{conn: conn} do
      conn = get(conn, "/api/runs/9999999")
      assert conn.status == 404
      assert json_response(conn, 404) == %{"error" => "not found"}
    end

    test "returns 200 for existing run", %{conn: conn, project_id: pid} do
      r = make_run(pid)
      body = conn |> get("/api/runs/#{r.id}") |> json_response(200)
      assert body["id"] == r.id
      assert body["project_id"] == pid
    end
  end

  describe "GET /api/runs/:id/siblings" do
    test "returns list for existing run", %{conn: conn, project_id: pid} do
      r = make_run(pid, %{prompt: "sibling-prompt"})
      _ = make_run(pid, %{prompt: "sibling-prompt"})
      body = conn |> get("/api/runs/#{r.id}/siblings") |> json_response(200)
      assert is_list(body)
    end

    test "returns 404 for missing run", %{conn: conn} do
      conn = get(conn, "/api/runs/9999999/siblings")
      assert conn.status == 404
    end
  end

  describe "GET /api/projects/:id/runs" do
    test "returns up to 50 runs for the project", %{conn: conn, project_id: pid} do
      Enum.each(1..3, fn _ -> make_run(pid) end)
      body = conn |> get("/api/projects/#{pid}/runs") |> json_response(200)
      assert is_list(body)
      assert length(body) <= 50
      assert Enum.all?(body, &(&1["project_id"] == pid))
    end
  end

  describe "POST /api/projects/:id/runs mock validation" do
    test "rejects mock=true when capability flag is off", %{conn: conn, project_id: pid} do
      Application.put_env(:fbi, :quantico_enabled, false)
      conn = post(conn, ~p"/api/projects/#{pid}/runs", %{"prompt" => "p", "mock" => true})
      assert json_response(conn, 400)["error"] =~ "quantico_disabled"
    end

    test "accepts mock=true with valid scenario when capability is on", %{conn: conn, project_id: pid} do
      Application.put_env(:fbi, :quantico_enabled, true)
      Application.put_env(:fbi, :quantico_scenarios, MapSet.new(["default"]))
      conn = post(conn, ~p"/api/projects/#{pid}/runs",
        %{"prompt" => "p", "mock" => true, "mock_scenario" => "default"})
      body = json_response(conn, 201)
      assert body["mock"] == true
      assert body["mock_scenario"] == "default"
    end

    test "rejects mock=true with unknown scenario name", %{conn: conn, project_id: pid} do
      Application.put_env(:fbi, :quantico_enabled, true)
      Application.put_env(:fbi, :quantico_scenarios, MapSet.new(["default"]))
      conn = post(conn, ~p"/api/projects/#{pid}/runs",
        %{"prompt" => "p", "mock" => true, "mock_scenario" => "nonsense"})
      assert json_response(conn, 400)["error"] =~ "invalid_scenario"
    end
  end

  describe "PATCH /api/runs/:id" do
    test "returns 400 for too-short (trimmed-empty) title", %{conn: conn, project_id: pid} do
      r = make_run(pid)
      conn = json_patch(conn, "/api/runs/#{r.id}", %{title: "   "})
      assert conn.status == 400
    end

    test "returns 400 for titles longer than 120 chars", %{conn: conn, project_id: pid} do
      r = make_run(pid)
      long = String.duplicate("a", 121)
      conn = json_patch(conn, "/api/runs/#{r.id}", %{title: long})
      assert conn.status == 400
    end

    test "returns 200 and sets title_locked=0 on valid title", %{conn: conn, project_id: pid} do
      r = make_run(pid, %{title: nil, title_locked: 1})
      body = conn |> json_patch("/api/runs/#{r.id}", %{title: "new-title"}) |> json_response(200)
      assert body["title"] == "new-title"
      assert body["title_locked"] == 0
    end

    test "returns 404 for missing run", %{conn: conn} do
      conn = json_patch(conn, "/api/runs/9999999", %{title: "whatever"})
      assert conn.status == 404
    end
  end

  describe "DELETE /api/runs/:id" do
    test "returns 204 for a queued run", %{conn: conn, project_id: pid} do
      r = make_run(pid, %{state: "queued"})
      conn = delete(conn, "/api/runs/#{r.id}")
      assert conn.status == 204
    end

    test "returns 204 for a running run; Docker.kill fails softly", %{
      conn: conn,
      project_id: pid
    } do
      r = make_run(pid, %{state: "running", container_id: "abc123"})
      conn = delete(conn, "/api/runs/#{r.id}")
      assert conn.status == 204
    end

    test "returns 404 for missing run", %{conn: conn} do
      conn = delete(conn, "/api/runs/9999999")
      assert conn.status == 404
    end
  end
end
