defmodule FBI.Runs.QueriesStateTransitionsTest do
  use FBI.DataCase

  alias FBI.Projects.Queries, as: Projects
  alias FBI.Runs.Queries
  alias FBI.Runs.Run
  alias FBI.Repo

  # Build a minimal run row for testing state transitions.
  defp insert_run(project_id, attrs \\ %{}) do
    now = System.os_time(:millisecond)

    defaults = %{
      project_id: project_id,
      prompt: "test prompt",
      branch_name: "claude/run-test",
      state: "queued",
      log_path: "/tmp/test-#{System.unique_integer([:positive])}.log",
      created_at: now,
      state_entered_at: now,
      kind: "work"
    }

    {:ok, run} =
      %Run{}
      |> Run.changeset(Map.merge(defaults, attrs))
      |> Repo.insert()

    run
  end

  setup do
    {:ok, p} = Projects.create(%{name: "p#{System.unique_integer([:positive])}", repo_url: "x"})
    %{project_id: p.id}
  end

  describe "new columns" do
    test "kind defaults to work", %{project_id: pid} do
      run = insert_run(pid)
      assert run.kind == "work"
    end

    test "kind_args_json is nullable", %{project_id: pid} do
      run = insert_run(pid, %{kind_args_json: ~s({"branch":"x"})})
      assert run.kind_args_json == ~s({"branch":"x"})
    end

    test "mirror_status is nullable", %{project_id: pid} do
      run = insert_run(pid, %{mirror_status: "ok"})
      assert run.mirror_status == "ok"
    end
  end

  describe "mark_starting_from_queued/2" do
    test "transitions queued -> starting", %{project_id: pid} do
      run = insert_run(pid)
      Queries.mark_starting_from_queued(run.id, "cont-abc")
      updated = Repo.get!(Run, run.id)
      assert updated.state == "starting"
      assert updated.container_id == "cont-abc"
      assert updated.started_at != nil
    end

    test "no-op if not queued", %{project_id: pid} do
      run = insert_run(pid, %{state: "running"})
      Queries.mark_starting_from_queued(run.id, "cont-abc")
      updated = Repo.get!(Run, run.id)
      assert updated.state == "running"
    end
  end

  describe "mark_awaiting_resume/2" do
    test "transitions running -> awaiting_resume", %{project_id: pid} do
      run = insert_run(pid, %{state: "running"})
      now = System.os_time(:millisecond)

      Queries.mark_awaiting_resume(run.id, %{
        next_resume_at: now + 60_000,
        last_limit_reset_at: now
      })

      updated = Repo.get!(Run, run.id)
      assert updated.state == "awaiting_resume"
      assert updated.resume_attempts == 1
      assert updated.container_id == nil
    end
  end

  describe "mark_starting_for_continue_request/1" do
    test "transitions succeeded -> starting, resets resume_attempts", %{project_id: pid} do
      run = insert_run(pid, %{state: "succeeded", resume_attempts: 3})
      Queries.mark_starting_for_continue_request(run.id)
      updated = Repo.get!(Run, run.id)
      assert updated.state == "starting"
      assert updated.resume_attempts == 0
    end
  end

  describe "mark_finished/2" do
    test "sets terminal state", %{project_id: pid} do
      run = insert_run(pid, %{state: "running"})

      Queries.mark_finished(run.id, %{
        state: "succeeded",
        exit_code: 0,
        head_commit: "abc123",
        branch_name: nil,
        error: nil
      })

      updated = Repo.get!(Run, run.id)
      assert updated.state == "succeeded"
      assert updated.exit_code == 0
      assert updated.finished_at != nil
    end
  end

  describe "list_active_by_branch/2" do
    test "returns running/queued/starting/waiting runs on a branch", %{project_id: pid} do
      run = insert_run(pid, %{state: "running", branch_name: "claude/run-1"})
      result = Queries.list_active_by_branch(run.project_id, "claude/run-1")
      assert length(result) == 1
      assert hd(result).id == run.id
    end

    test "excludes terminal runs", %{project_id: pid} do
      run = insert_run(pid, %{state: "succeeded", branch_name: "claude/run-1"})
      result = Queries.list_active_by_branch(run.project_id, "claude/run-1")
      assert result == []
    end
  end

  describe "list_awaiting/0" do
    test "returns awaiting_resume runs with next_resume_at", %{project_id: pid} do
      now = System.os_time(:millisecond)
      run = insert_run(pid, %{state: "awaiting_resume", next_resume_at: now + 60_000})
      rows = Queries.list_awaiting()
      ids = Enum.map(rows, & &1.id)
      assert run.id in ids
    end
  end
end
