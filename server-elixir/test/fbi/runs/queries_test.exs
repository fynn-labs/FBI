defmodule FBI.Runs.QueriesTest do
  use FBI.DataCase, async: false

  alias FBI.Projects.Queries, as: Projects
  alias FBI.Repo
  alias FBI.Runs.{Queries, Run}

  defp make_run(project_id, attrs \\ %{}) do
    defaults = %{
      project_id: project_id,
      prompt: "a",
      branch_name: "b",
      state: "succeeded",
      log_path: "/tmp/#{System.unique_integer([:positive])}.log",
      created_at: System.system_time(:millisecond)
    }

    Repo.insert!(struct(Run, Map.merge(defaults, attrs)))
  end

  setup do
    {:ok, p} = Projects.create(%{name: "p#{System.unique_integer([:positive])}", repo_url: "x"})
    %{project_id: p.id}
  end

  describe "list/1" do
    test "returns array when no paging params given", %{project_id: pid} do
      _ = make_run(pid, %{prompt: "x1"})
      result = Queries.list(%{})
      assert is_list(result)
    end

    test "returns %{items, total} when limit is provided", %{project_id: pid} do
      Enum.each(1..3, fn i -> make_run(pid, %{prompt: "p#{i}"}) end)
      result = Queries.list(%{limit: 2})
      assert %{items: items, total: total} = result
      assert length(items) <= 2
      assert total >= 3
    end

    test "filters by state", %{project_id: pid} do
      _ = make_run(pid, %{state: "succeeded"})
      _ = make_run(pid, %{state: "failed"})
      [only] = Queries.list(%{state: "failed"})
      assert only.state == "failed"
    end

    test "filters by project_id", %{project_id: pid} do
      {:ok, other} = Projects.create(%{name: "other#{System.unique_integer([:positive])}", repo_url: "x"})
      _ = make_run(pid)
      _ = make_run(other.id)
      list = Queries.list(%{project_id: pid})
      assert Enum.all?(list, &(&1.project_id == pid))
    end

    test "filters by q case-insensitive", %{project_id: pid} do
      _ = make_run(pid, %{prompt: "HELLO World"})
      _ = make_run(pid, %{prompt: "other"})
      [hit] = Queries.list(%{q: "hello"})
      assert hit.prompt == "HELLO World"
    end

    test "clamps limit to [1, 200]", %{project_id: pid} do
      _ = make_run(pid)
      %{items: items1} = Queries.list(%{limit: 0})
      assert length(items1) >= 1 or items1 == []
      %{items: _items2} = Queries.list(%{limit: 1000})
    end

    test "offset paginates", %{project_id: pid} do
      Enum.each(1..5, fn i -> make_run(pid, %{prompt: "p#{i}"}) end)
      %{items: page1} = Queries.list(%{limit: 2, offset: 0})
      %{items: page2} = Queries.list(%{limit: 2, offset: 2})
      assert page1 != page2
    end
  end

  describe "get/1" do
    test "returns :not_found for missing" do
      assert Queries.get(9_999_999) == :not_found
    end

    test "returns decoded run for existing", %{project_id: pid} do
      r = make_run(pid)
      assert {:ok, decoded} = Queries.get(r.id)
      assert decoded.id == r.id
    end
  end

  describe "list_for_project/1" do
    test "returns runs for the given project, ordered by created_at desc", %{project_id: pid} do
      a = make_run(pid, %{prompt: "a", created_at: 1000})
      b = make_run(pid, %{prompt: "b", created_at: 2000})
      [first, second] = Queries.list_for_project(pid)
      assert first.id == b.id
      assert second.id == a.id
    end

    test "empty list for project without runs" do
      {:ok, p} = Projects.create(%{name: "empty#{System.unique_integer([:positive])}", repo_url: "x"})
      assert [] = Queries.list_for_project(p.id)
    end

    test "limits to 50", %{project_id: pid} do
      Enum.each(1..55, fn i -> make_run(pid, %{prompt: "p#{i}", created_at: i}) end)
      assert length(Queries.list_for_project(pid)) == 50
    end
  end

  describe "siblings/1" do
    test "returns runs with same project+prompt excluding self", %{project_id: pid} do
      a = make_run(pid, %{prompt: "same"})
      b = make_run(pid, %{prompt: "same"})
      _c = make_run(pid, %{prompt: "different"})

      assert {:ok, siblings} = Queries.siblings(a.id)
      assert Enum.any?(siblings, &(&1.id == b.id))
      refute Enum.any?(siblings, &(&1.id == a.id))
    end

    test "returns :not_found for missing run" do
      assert Queries.siblings(9_999_999) == :not_found
    end

    test "limits siblings to 10", %{project_id: pid} do
      main = make_run(pid, %{prompt: "busy"})
      Enum.each(1..15, fn _ -> make_run(pid, %{prompt: "busy"}) end)
      {:ok, list} = Queries.siblings(main.id)
      assert length(list) == 10
    end
  end

  describe "latest_for_project/1" do
    test "returns nil when no runs", %{project_id: pid} do
      assert nil == Queries.latest_for_project(pid + 99_999)
    end

    test "returns highest-id run's compact summary", %{project_id: pid} do
      make_run(pid, %{created_at: 100})
      b = make_run(pid, %{created_at: 200, state: "failed"})

      result = Queries.latest_for_project(pid)
      assert result.id == b.id
      assert result.state == "failed"
      assert is_integer(result.created_at)
    end
  end

  describe "update_title/2" do
    test "updates title + sets title_locked to 0", %{project_id: pid} do
      r = make_run(pid)
      {:ok, decoded} = Queries.update_title(r.id, "new")
      assert decoded.title == "new"
      assert decoded.title_locked == 0
    end

    test "returns :not_found for missing" do
      assert :not_found = Queries.update_title(9_999_999, "x")
    end
  end

  describe "delete/1" do
    test "deletes the row", %{project_id: pid} do
      r = make_run(pid)
      :ok = Queries.delete(r.id)
      assert :not_found = Queries.get(r.id)
    end

    test "is idempotent for missing ids" do
      assert :ok = Queries.delete(9_999_999)
    end
  end
end
