defmodule FBI.Projects.QueriesTest do
  use FBI.DataCase, async: false

  alias FBI.Projects.Queries

  defp make(attrs \\ %{}) do
    defaults = %{
      name: "proj-#{System.unique_integer([:positive])}",
      repo_url: "git@github.com:owner/repo.git"
    }

    Queries.create(Map.merge(defaults, attrs))
  end

  describe "create/1 + list/0" do
    test "creates a project and lists include it" do
      {:ok, p} = make()
      list = Queries.list()
      assert Enum.any?(list, fn x -> x.id == p.id and x.name == p.name end)
    end

    test "create defaults marketplaces/plugins to empty lists" do
      {:ok, p} = make()
      assert p.marketplaces == []
      assert p.plugins == []
    end

    test "create accepts marketplaces/plugins lists and roundtrips them" do
      {:ok, p} = make(%{marketplaces: ["m1"], plugins: ["p1", "p2"]})
      assert p.marketplaces == ["m1"]
      assert p.plugins == ["p1", "p2"]
    end

    test "list orders by updated_at DESC" do
      {:ok, a} = make()
      :timer.sleep(2)
      {:ok, b} = make()
      ids = Enum.map(Queries.list(), & &1.id)

      assert Enum.find_index(ids, &(&1 == b.id)) <
               Enum.find_index(ids, &(&1 == a.id))
    end
  end

  describe "get/1" do
    test "returns project by id" do
      {:ok, p} = make()
      assert {:ok, g} = Queries.get(p.id)
      assert g.id == p.id
    end

    test "returns :not_found when absent" do
      assert Queries.get(9_999_999) == :not_found
    end
  end

  describe "update/2" do
    test "merges patch and bumps updated_at" do
      {:ok, p} = make()
      :timer.sleep(2)
      {:ok, u} = Queries.update(p.id, %{instructions: "hi"})
      assert u.instructions == "hi"
      assert u.updated_at > p.updated_at
    end

    test "returns :not_found for absent project" do
      assert Queries.update(9_999_999, %{name: "x"}) == :not_found
    end
  end

  describe "delete/1" do
    test "deletes the project" do
      {:ok, p} = make()
      assert :ok = Queries.delete(p.id)
      assert Queries.get(p.id) == :not_found
    end

    test "is idempotent for missing projects" do
      assert :ok = Queries.delete(9_999_999)
    end
  end

  describe "list_recent_prompts/2" do
    test "returns distinct prompts ordered by recency, limit clamped to [1,50]" do
      {:ok, p} = make()
      ms = System.system_time(:millisecond)

      FBI.Repo.insert!(%FBI.Runs.Run{
        project_id: p.id,
        prompt: "a",
        branch_name: "b",
        state: "succeeded",
        log_path: "/tmp/a.log",
        created_at: ms - 2000
      })

      FBI.Repo.insert!(%FBI.Runs.Run{
        project_id: p.id,
        prompt: "b",
        branch_name: "b",
        state: "succeeded",
        log_path: "/tmp/b.log",
        created_at: ms - 1000
      })

      FBI.Repo.insert!(%FBI.Runs.Run{
        project_id: p.id,
        prompt: "a",
        branch_name: "b",
        state: "succeeded",
        log_path: "/tmp/a2.log",
        created_at: ms
      })

      [r1, r2] = Queries.list_recent_prompts(p.id, 10)
      assert r1.prompt == "a"
      assert r2.prompt == "b"

      [only] = Queries.list_recent_prompts(p.id, 0)
      assert only.prompt == "a"
    end
  end
end
