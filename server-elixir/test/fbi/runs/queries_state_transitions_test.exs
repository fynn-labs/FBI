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
end
