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

  defp json_post(conn, url, body) do
    conn
    |> put_req_header("content-type", "application/json")
    |> post(url, Jason.encode!(body))
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

    test "returns 200 and sets title_locked=1 on valid title", %{conn: conn, project_id: pid} do
      r = make_run(pid, %{title: nil, title_locked: 0})
      body = conn |> json_patch("/api/runs/#{r.id}", %{title: "User pick"}) |> json_response(200)
      assert body["title"] == "User pick"
      assert body["title_locked"] == 1
    end

    test "locks title even when already locked", %{conn: conn, project_id: pid} do
      r = make_run(pid, %{title: nil, title_locked: 1})
      body = conn |> json_patch("/api/runs/#{r.id}", %{title: "new-title"}) |> json_response(200)
      assert body["title"] == "new-title"
      assert body["title_locked"] == 1
    end

    test "returns 404 for missing run", %{conn: conn} do
      conn = json_patch(conn, "/api/runs/9999999", %{title: "whatever"})
      assert conn.status == 404
    end

    test "PATCH /api/runs/:id publishes a title event on Phoenix.PubSub", %{
      conn: conn,
      project_id: pid
    } do
      run = make_run(pid)
      Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run.id}:events")
      json_patch(conn, "/api/runs/#{run.id}", %{title: "Hello"})
      assert_receive {:run_event, %{type: "title", title: "Hello", title_locked: 1}}, 500
    end
  end

  describe "POST /api/runs/:id/continue model params" do
    setup do
      # Provide a runs_dir with a populated claude-projects subtree so
      # ContinueEligibility.check/2 passes for the persistence test.
      runs_dir =
        Path.join(System.tmp_dir!(), "fbi-runs-test-#{System.unique_integer([:positive])}")

      File.mkdir_p!(runs_dir)
      prev = Application.get_env(:fbi, :runs_dir)
      Application.put_env(:fbi, :runs_dir, runs_dir)

      on_exit(fn ->
        if prev,
          do: Application.put_env(:fbi, :runs_dir, prev),
          else: Application.delete_env(:fbi, :runs_dir)

        File.rm_rf!(runs_dir)
      end)

      %{runs_dir: runs_dir}
    end

    defp seed_session_files(runs_dir, run_id) do
      sub = Path.join([runs_dir, to_string(run_id), "claude-projects", "-workspace"])
      File.mkdir_p!(sub)
      File.write!(Path.join(sub, "00000000-0000-0000-0000-000000000000.jsonl"), "{}\n")
    end

    test "rejects invalid model with 400", %{conn: conn, project_id: pid, runs_dir: runs_dir} do
      run =
        make_run(pid, %{
          state: "succeeded",
          claude_session_id: "00000000-0000-0000-0000-000000000000"
        })

      seed_session_files(runs_dir, run.id)
      conn = json_post(conn, "/api/runs/#{run.id}/continue", %{model: "gpt"})
      assert %{"error" => "invalid model: gpt"} = json_response(conn, 400)
    end

    test "persists provided model params before continuing", %{
      conn: conn,
      project_id: pid,
      runs_dir: runs_dir
    } do
      run =
        make_run(pid, %{
          state: "succeeded",
          claude_session_id: "00000000-0000-0000-0000-000000000000"
        })

      seed_session_files(runs_dir, run.id)

      # The orchestrator continue_run/1 may fail (no daemon in unit tests).
      # We only assert the DB write landed, not the response status.
      json_post(conn, "/api/runs/#{run.id}/continue", %{
        model: "opus",
        effort: "xhigh",
        subagent_model: "haiku"
      })

      {:ok, fresh} = FBI.Runs.Queries.get(run.id)
      assert fresh.model == "opus"
      assert fresh.effort == "xhigh"
      assert fresh.subagent_model == "haiku"
    end

    test "returns 409 (not 400) when both eligibility and model params would fail", %{
      conn: conn,
      project_id: pid
    } do
      # A 'running' run is ineligible for continue. With an invalid model in the
      # body, TS returns 409 (eligibility wins). We mirror that.
      run = make_run(pid, %{state: "running"})
      conn = json_post(conn, "/api/runs/#{run.id}/continue", %{model: "gpt"})
      body = json_response(conn, 409)
      # eligibility verdict carries a `code` and `message`, not an `error` string.
      assert is_binary(body["code"])
      assert is_binary(body["message"])
    end
  end

  describe "POST /api/projects/:id/runs model params" do
    test "rejects invalid effort with 400", %{conn: conn} do
      {:ok, p} =
        ProjectsQueries.create(%{
          name: "p-#{System.unique_integer([:positive])}",
          repo_url: "git@github.com:o/r.git",
          default_branch: "main"
        })

      conn = json_post(conn, "/api/projects/#{p.id}/runs", %{prompt: "hi", effort: "blast"})
      assert %{"error" => "invalid effort: blast"} = json_response(conn, 400)
    end
  end

  describe "POST /api/projects/:id/runs draft_token promotion" do
    setup do
      runs_dir =
        Path.join(System.tmp_dir!(), "fbi-runs-create-#{System.unique_integer([:positive])}")

      draft_dir =
        Path.join(System.tmp_dir!(), "fbi-drafts-create-#{System.unique_integer([:positive])}")

      File.mkdir_p!(runs_dir)
      File.mkdir_p!(draft_dir)

      prev_runs = Application.get_env(:fbi, :runs_dir)
      prev_drafts = Application.get_env(:fbi, :draft_uploads_dir)
      Application.put_env(:fbi, :runs_dir, runs_dir)
      Application.put_env(:fbi, :draft_uploads_dir, draft_dir)

      on_exit(fn ->
        if prev_runs,
          do: Application.put_env(:fbi, :runs_dir, prev_runs),
          else: Application.delete_env(:fbi, :runs_dir)

        if prev_drafts,
          do: Application.put_env(:fbi, :draft_uploads_dir, prev_drafts),
          else: Application.delete_env(:fbi, :draft_uploads_dir)

        File.rm_rf!(runs_dir)
        File.rm_rf!(draft_dir)
      end)

      %{runs_dir: runs_dir, draft_dir: draft_dir}
    end

    test "promotes draft files into the new run", %{
      conn: conn,
      runs_dir: runs_dir,
      draft_dir: draft_dir
    } do
      token = "0123456789abcdef0123456789abcdef"
      File.mkdir_p!(Path.join(draft_dir, token))
      File.write!(Path.join([draft_dir, token, "note.txt"]), "hi")

      {:ok, p} =
        ProjectsQueries.create(%{
          name: "p-#{System.unique_integer([:positive])}",
          repo_url: "git@github.com:o/r.git",
          default_branch: "main"
        })

      conn = json_post(conn, "/api/projects/#{p.id}/runs", %{prompt: "x", draft_token: token})
      body = json_response(conn, 201)
      run_id = body["id"]

      uploads_dir =
        Path.join([runs_dir, Integer.to_string(run_id), "uploads"])

      assert File.exists?(Path.join(uploads_dir, "note.txt"))
      refute File.exists?(Path.join(draft_dir, token))
    end

    test "rejects malformed draft_token", %{conn: conn} do
      {:ok, p} =
        ProjectsQueries.create(%{
          name: "p-#{System.unique_integer([:positive])}",
          repo_url: "git@github.com:o/r.git",
          default_branch: "main"
        })

      conn =
        json_post(conn, "/api/projects/#{p.id}/runs", %{
          prompt: "x",
          draft_token: "not-a-token"
        })

      assert %{"error" => "invalid_token"} = json_response(conn, 400)
    end
  end

  describe "DELETE /api/runs/:id" do
    test "returns 204 for a queued run", %{conn: conn, project_id: pid} do
      r = make_run(pid, %{state: "queued"})
      conn = delete(conn, "/api/runs/#{r.id}")
      assert conn.status == 204
    end

    test "returns 409 for a running run without an active RunServer", %{
      conn: conn,
      project_id: pid
    } do
      # A running run without a RunServer cannot be cancelled (no process to handle
      # the cancel message). The delete_run call sees the run still in "running"
      # and returns {:error, :run_active}, which the controller surfaces as 409.
      r = make_run(pid, %{state: "running", container_id: "abc123"})
      conn = delete(conn, "/api/runs/#{r.id}")
      assert json_response(conn, 409)
    end

    test "returns 404 for missing run", %{conn: conn} do
      conn = delete(conn, "/api/runs/9999999")
      assert conn.status == 404
    end
  end

  describe "DELETE /api/runs/:id orchestrator routing" do
    setup do
      runs_dir =
        Path.join(System.tmp_dir!(), "fbi-runs-delete-#{System.unique_integer([:positive])}")

      File.mkdir_p!(runs_dir)
      prev = Application.get_env(:fbi, :runs_dir)
      Application.put_env(:fbi, :runs_dir, runs_dir)

      on_exit(fn ->
        if prev,
          do: Application.put_env(:fbi, :runs_dir, prev),
          else: Application.delete_env(:fbi, :runs_dir)

        File.rm_rf!(runs_dir)
      end)

      %{runs_dir: runs_dir}
    end

    test "DELETE cancels the ResumeScheduler timer for awaiting_resume runs", %{
      conn: conn,
      project_id: pid
    } do
      run = make_run(pid, %{state: "awaiting_resume"})

      # Schedule a far-future timer for this run so we can observe whether
      # DELETE cancels it. Without the orchestrator routing, the timer leaks.
      fire_at = System.os_time(:millisecond) + 60_000

      :ok =
        FBI.Orchestrator.ResumeScheduler.schedule(
          FBI.Orchestrator.ResumeScheduler,
          run.id,
          fire_at
        )

      before_state = :sys.get_state(FBI.Orchestrator.ResumeScheduler)
      assert Map.has_key?(before_state.timers, run.id)

      conn = delete(conn, "/api/runs/#{run.id}")
      assert response(conn, 204)

      after_state = :sys.get_state(FBI.Orchestrator.ResumeScheduler)
      refute Map.has_key?(after_state.timers, run.id)

      # The orchestrator's delete_run path should also remove the row.
      assert :not_found = FBI.Runs.Queries.get(run.id)
    end

    test "DELETE removes the WIP repo for terminal runs", %{
      conn: conn,
      project_id: pid,
      runs_dir: runs_dir
    } do
      run = make_run(pid, %{state: "succeeded"})

      # Create a fake WIP bare-repo dir for this run to confirm it gets removed.
      wip_path = Path.join([runs_dir, Integer.to_string(run.id), "wip.git"])
      File.mkdir_p!(wip_path)
      File.write!(Path.join(wip_path, "HEAD"), "ref: refs/heads/main")

      conn = delete(conn, "/api/runs/#{run.id}")
      assert response(conn, 204)
      refute File.exists?(wip_path)
    end

    test "DELETE returns 409 if Orchestrator can't cancel and run stays active", %{
      conn: conn,
      project_id: pid
    } do
      # Create a run in 'running' state. Without a real RunServer registered for
      # this run, Orchestrator.cancel/1 falls through to RunServer.cancel/1 which
      # is a no-op against a missing registry entry. Then delete_run/1 sees the
      # row still in 'running' and returns {:error, :run_active}.
      run = make_run(pid, %{state: "running"})

      conn = delete(conn, "/api/runs/#{run.id}")
      body = json_response(conn, 409)
      assert is_binary(body["error"])
    end
  end
end
