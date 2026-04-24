defmodule FBIWeb.FilesControllerTest do
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries, as: Projects
  alias FBI.Repo
  alias FBI.Runs.Run

  setup do
    prev_adapter = Application.get_env(:fbi, :gh_cmd_adapter)

    on_exit(fn ->
      if prev_adapter do
        Application.put_env(:fbi, :gh_cmd_adapter, prev_adapter)
      else
        Application.delete_env(:fbi, :gh_cmd_adapter)
      end
    end)

    :ok
  end

  defp make_run(attrs \\ %{}) do
    {:ok, p} =
      Projects.create(%{
        name: "proj-#{System.unique_integer([:positive])}",
        repo_url: attrs[:repo_url] || "git@github.com:owner/r.git",
        default_branch: "main"
      })

    run_defaults = %{
      project_id: p.id,
      prompt: "x",
      branch_name: "feature-1",
      state: "succeeded",
      log_path: "/tmp/#{System.unique_integer([:positive])}.log",
      created_at: System.system_time(:millisecond)
    }

    Repo.insert!(struct(Run, Map.merge(run_defaults, Map.drop(attrs, [:repo_url]))))
  end

  test "404 for missing run", %{conn: conn} do
    conn = get(conn, "/api/runs/999999/files")
    assert conn.status == 404
    assert json_response(conn, 404) == %{"error" => "not found"}
  end

  test "returns sparse fallback for non-github project", %{conn: conn} do
    run = make_run(%{repo_url: "not-a-github-url"})
    body = conn |> get("/api/runs/#{run.id}/files") |> json_response(200)

    assert body["live"] == false
    assert body["dirty"] == []
    assert body["headFiles"] == []
    assert body["head"] == nil
    assert body["branchBase"] == nil
  end

  test "returns mapped headFiles on gh compare success", %{conn: conn} do
    Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
      {:ok,
       Jason.encode!([
         %{"filename" => "a.ex", "additions" => 10, "deletions" => 2, "status" => "added"},
         %{"filename" => "b.ex", "additions" => 0, "deletions" => 5, "status" => "removed"},
         %{"filename" => "c.ex", "additions" => 3, "deletions" => 3, "status" => "renamed"},
         %{"filename" => "d.ex", "additions" => 1, "deletions" => 1, "status" => "modified"}
       ])}
    end)

    run = make_run()
    body = conn |> get("/api/runs/#{run.id}/files") |> json_response(200)

    assert body["live"] == false

    assert body["headFiles"] == [
             %{"filename" => "a.ex", "additions" => 10, "deletions" => 2, "status" => "A"},
             %{"filename" => "b.ex", "additions" => 0, "deletions" => 5, "status" => "D"},
             %{"filename" => "c.ex", "additions" => 3, "deletions" => 3, "status" => "R"},
             %{"filename" => "d.ex", "additions" => 1, "deletions" => 1, "status" => "M"}
           ]

    assert body["branchBase"]["base"] == "main"
    assert body["branchBase"]["ahead"] == 1
    assert body["branchBase"]["behind"] == 0
  end

  test "returns empty headFiles when compare returns empty list", %{conn: conn} do
    Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:ok, "[]"} end)
    run = make_run()

    body = conn |> get("/api/runs/#{run.id}/files") |> json_response(200)
    assert body["headFiles"] == []
    assert body["branchBase"]["ahead"] == 0
    assert body["live"] == false
  end

  test "returns empty_payload when compare errors", %{conn: conn} do
    Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:error, {1, "boom"}} end)
    run = make_run()

    body = conn |> get("/api/runs/#{run.id}/files") |> json_response(200)
    assert body["headFiles"] == []
    assert body["live"] == false
    assert body["branchBase"]["base"] == "main"
  end
end
