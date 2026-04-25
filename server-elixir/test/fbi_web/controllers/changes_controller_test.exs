defmodule FBIWeb.ChangesControllerTest do
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries, as: ProjectsQueries
  alias FBI.Repo
  alias FBI.Runs.Run

  setup do
    {:ok, project} =
      ProjectsQueries.create(%{
        name: "test-changes-#{System.unique_integer([:positive])}",
        repo_url: "git@github.com:org/repo.git",
        default_branch: "main"
      })

    run =
      Repo.insert!(
        struct(Run, %{
          project_id: project.id,
          prompt: "p",
          branch_name: "claude/run-1",
          state: "succeeded",
          log_path: "/tmp/r_#{System.unique_integer([:positive])}.log",
          created_at: System.os_time(:millisecond),
          kind: "work"
        })
      )

    # The ChangesCache is a global Agent that survives between tests; make
    # sure each test starts from a clean slate for this run_id.
    FBI.Runs.ChangesCache.invalidate(run.id)

    {:ok, run_id: run.id, project: project}
  end

  describe "GET /api/runs/:id/changes" do
    test "returns empty changes for a run with no wip repo", %{conn: conn, run_id: run_id} do
      conn = get(conn, "/api/runs/#{run_id}/changes")
      assert conn.status == 200
      body = json_response(conn, 200)
      assert is_list(body["commits"])
      assert body["uncommitted"] == []
    end

    test "returns 404 for missing run", %{conn: conn} do
      conn = get(conn, "/api/runs/99999/changes")
      assert conn.status == 404
    end
  end

  describe "GET /api/runs/:id/commits/:sha/files" do
    test "returns empty files for unknown sha", %{conn: conn, run_id: run_id} do
      conn = get(conn, "/api/runs/#{run_id}/commits/aabbccdd/files")
      assert conn.status == 200
      body = json_response(conn, 200)
      assert body["files"] == []
    end
  end

  describe "GET /api/runs/:id/submodule/*path" do
    test "returns 404 for run-not-found", %{conn: conn} do
      # Stable smoke test: hits the route, confirms no crash, asserts 404 because run doesn't exist.
      conn = get(conn, "/api/runs/9999999/submodule/foo/bar/commits/abcdef0/files")
      assert response(conn, 404)
    end

    test "returns 400 for path traversal attempts", %{conn: conn, run_id: run_id} do
      # Run a real request through the route; validates list->string normalization works.
      # If the list normalization were missing, this would 500 with FunctionClauseError instead of 400.
      # The %2F (URL-encoded /) keeps `..` inside a single segment so it survives to the body check.
      conn = get(conn, "/api/runs/#{run_id}/submodule/..%2Fevil/commits/abcdef0/files")
      assert response(conn, 400)
    end
  end

  # Real behavioral tests stubbing the gh CLI through :gh_cmd_adapter.
  # The run is created with container_id == nil, so any docker-exec branch
  # naturally falls through to :no_container and exercises the gh fallback.
  describe "GH-backed behavior with stubbed adapter" do
    setup do
      prev = Application.get_env(:fbi, :gh_cmd_adapter)

      on_exit(fn ->
        if prev,
          do: Application.put_env(:fbi, :gh_cmd_adapter, prev),
          else: Application.delete_env(:fbi, :gh_cmd_adapter)
      end)

      :ok
    end

    defp stub_gh(fun) when is_function(fun, 1) do
      Application.put_env(:fbi, :gh_cmd_adapter, fun)
    end

    test "show/2: uses GH.compare_branch and surfaces branch_base with base/ahead/behind",
         %{conn: conn, run_id: run_id} do
      stub_gh(fn args ->
        case args do
          # pr_for_branch
          ["pr", "list" | _] ->
            {:ok, "[]"}

          # compare_branch
          ["api", "repos/org/repo/compare/" <> _rest] ->
            {:ok,
             Jason.encode!(%{
               "ahead_by" => 2,
               "behind_by" => 1,
               "merge_base_commit" => %{"sha" => "deadbeef"},
               "commits" => [
                 %{
                   "sha" => "s1",
                   "commit" => %{
                     "message" => "subject\nbody",
                     "committer" => %{"date" => "2026-04-25T12:00:00Z"}
                   }
                 }
               ]
             })}

          _ ->
            {:ok, "[]"}
        end
      end)

      conn = get(conn, "/api/runs/#{run_id}/changes")
      body = json_response(conn, 200)

      # branch_base shape (TS parity): %{base, ahead, behind}, never %{ahead_by, behind_by}.
      assert body["branch_base"]["base"] == "main"
      assert body["branch_base"]["ahead"] == 2
      assert body["branch_base"]["behind"] == 1
      refute Map.has_key?(body["branch_base"], "ahead_by")
      refute Map.has_key?(body["branch_base"], "behind_by")

      # GH commits (pushed: true) come through; safeguard repo is empty so this is the full set.
      assert [%{"sha" => "s1", "subject" => "subject", "pushed" => true}] = body["commits"]
    end

    test "show/2: falls back to safeguard-only payload when GH compare errors",
         %{conn: conn, run_id: run_id} do
      stub_gh(fn args ->
        case args do
          ["pr", "list" | _] -> {:ok, "[]"}
          ["api", "repos/" <> _] -> {:error, {1, "boom"}}
          _ -> {:ok, "[]"}
        end
      end)

      conn = get(conn, "/api/runs/#{run_id}/changes")
      body = json_response(conn, 200)

      # On GH error, branch_base should still exist (with zero ahead/behind)
      # because the GH path was reached but compare itself failed.
      assert body["branch_base"]["base"] == "main"
      assert body["branch_base"]["ahead"] == 0
      assert body["branch_base"]["behind"] == 0
      # No safeguard repo on disk -> commits is empty.
      assert body["commits"] == []
    end

    test "commit_files/2: with no container, falls back to GH.compare_files",
         %{conn: conn, run_id: run_id} do
      stub_gh(fn args ->
        # gh_compare_files calls: ["api", "repos/<repo>/compare/<base>...<head>", "--jq", _]
        case args do
          ["api", "repos/org/repo/compare/" <> _, "--jq", _] ->
            {:ok,
             Jason.encode!([
               %{
                 "filename" => "a.txt",
                 "additions" => 3,
                 "deletions" => 0,
                 "status" => "added"
               },
               %{
                 "filename" => "b.txt",
                 "additions" => 1,
                 "deletions" => 1,
                 "status" => "modified"
               }
             ])}

          _ ->
            {:error, {1, "unexpected gh call: #{inspect(args)}"}}
        end
      end)

      conn = get(conn, "/api/runs/#{run_id}/commits/abcdef1234567/files")
      body = json_response(conn, 200)

      # Status mapping: "added" -> "A", "modified" -> "M".
      assert [
               %{"path" => "a.txt", "status" => "A", "additions" => 3, "deletions" => 0},
               %{"path" => "b.txt", "status" => "M", "additions" => 1, "deletions" => 1}
             ] = body["files"]
    end

    test "commit_files/2: returns [] when GH compare_files itself errors",
         %{conn: conn, run_id: run_id} do
      stub_gh(fn _args -> {:error, {1, "boom"}} end)

      conn = get(conn, "/api/runs/#{run_id}/commits/abcdef1234567/files")
      body = json_response(conn, 200)
      assert body["files"] == []
    end

    test "submodule_files/2: with no container, returns [] (no GH fallback for submodules)",
         %{conn: conn, run_id: run_id} do
      # The route should NOT call gh; assert that by failing loudly if it does.
      stub_gh(fn args ->
        flunk("submodule_files should not invoke gh; got args=#{inspect(args)}")
      end)

      conn = get(conn, "/api/runs/#{run_id}/submodule/sub/path/commits/abcdef1234567/files")
      body = json_response(conn, 200)
      assert body["files"] == []
    end

    test "issues pr_for_branch and compare_branch concurrently", %{conn: conn, run_id: run_id} do
      parent = self()

      stub_gh(fn args ->
        send(parent, {:gh_call, args, System.monotonic_time(:millisecond)})
        Process.sleep(80)

        cond do
          Enum.any?(args, &String.contains?(&1, "compare/")) ->
            {:ok,
             ~s|{"ahead_by": 0, "behind_by": 0, "merge_base_commit": {"sha": ""}, "commits": []}|}

          Enum.any?(args, &String.contains?(&1, "/pulls?")) ->
            {:ok, "[]"}

          true ->
            {:ok, "[]"}
        end
      end)

      start = System.monotonic_time(:millisecond)
      conn = get(conn, "/api/runs/#{run_id}/changes")
      elapsed = System.monotonic_time(:millisecond) - start
      assert json_response(conn, 200)

      # Two 80ms stubs run in parallel should finish in well under 160ms.
      assert elapsed < 140, "expected concurrent gh calls (<140ms), got #{elapsed}ms"

      # Both calls fired (order doesn't matter).
      assert_received {:gh_call, _args1, _t1}
      assert_received {:gh_call, _args2, _t2}
    end
  end
end
