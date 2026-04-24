defmodule FBI.Mcp.QueriesTest do
  @moduledoc "Tests for `FBI.Mcp.Queries`: global vs. project-scoped isolation."
  use FBI.DataCase, async: false

  alias FBI.Mcp.Queries
  alias FBI.Mcp.Server
  alias FBI.Projects.Queries, as: ProjectQueries

  defp make_project(attrs \\ %{}) do
    defaults = %{
      name: "mcp-proj-#{System.unique_integer([:positive])}",
      repo_url: "git@example.com:x/y.git"
    }

    {:ok, p} = ProjectQueries.create(Map.merge(defaults, attrs))
    p
  end

  describe "create/1" do
    test "creates a global row when project_id is nil" do
      {:ok, s} =
        Queries.create(%{
          project_id: nil,
          name: "global-fetch",
          type: "stdio",
          command: "npx",
          args: ["-y", "@mcp/fetch"]
        })

      assert s.id > 0
      assert s.project_id == nil
      assert s.name == "global-fetch"
      assert s.type == "stdio"
      assert s.command == "npx"
      assert s.args == ["-y", "@mcp/fetch"]
      assert s.env == %{}
      assert s.created_at > 0
    end

    test "creates a project-scoped row when project_id is an integer" do
      p = make_project()

      {:ok, s} =
        Queries.create(%{
          project_id: p.id,
          name: "scoped-gh",
          type: "stdio",
          command: "npx",
          args: [],
          env: %{"TOKEN" => "abc"}
        })

      assert s.project_id == p.id
      assert s.env == %{"TOKEN" => "abc"}
    end

    test "rejects type not in [stdio, sse]" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Queries.create(%{
                 project_id: nil,
                 name: "bad-type",
                 type: "websocket",
                 command: "npx"
               })

      assert %{type: _} = errors_on(cs)
    end

    test "rejects duplicate (project_id, name)" do
      p = make_project()
      {:ok, _} = Queries.create(%{project_id: p.id, name: "x", type: "stdio", command: "npx"})

      assert {:error, %Ecto.Changeset{}} =
               Queries.create(%{project_id: p.id, name: "x", type: "stdio", command: "npx"})
    end
  end

  describe "list_global/0" do
    test "returns only nil-project_id rows, ordered by name asc" do
      p = make_project()
      {:ok, _} = Queries.create(%{project_id: nil, name: "zulu", type: "stdio", command: "npx"})
      {:ok, _} = Queries.create(%{project_id: nil, name: "alpha", type: "stdio", command: "npx"})
      {:ok, _} = Queries.create(%{project_id: p.id, name: "scoped", type: "stdio", command: "npx"})

      rows = Queries.list_global()
      names = Enum.map(rows, & &1.name)
      assert names == ["alpha", "zulu"]
      assert Enum.all?(rows, fn r -> r.project_id == nil end)
    end
  end

  describe "list_for_project/1" do
    test "returns only matching project_id, ordered by name asc" do
      p1 = make_project()
      p2 = make_project()
      {:ok, _} = Queries.create(%{project_id: nil, name: "global", type: "stdio", command: "npx"})
      {:ok, _} = Queries.create(%{project_id: p1.id, name: "zeta", type: "stdio", command: "npx"})
      {:ok, _} = Queries.create(%{project_id: p1.id, name: "beta", type: "stdio", command: "npx"})
      {:ok, _} = Queries.create(%{project_id: p2.id, name: "other", type: "stdio", command: "npx"})

      rows = Queries.list_for_project(p1.id)
      names = Enum.map(rows, & &1.name)
      assert names == ["beta", "zeta"]
      assert Enum.all?(rows, fn r -> r.project_id == p1.id end)
    end
  end

  describe "update/2" do
    test "updates via %Server{} + patch map, re-encodes args/env" do
      {:ok, s} =
        Queries.create(%{
          project_id: nil,
          name: "upd",
          type: "stdio",
          command: "npx",
          args: ["a"]
        })

      row = Repo.get(Server, s.id)

      {:ok, updated} =
        Queries.update(row, %{args: ["-y", "updated"], env: %{"FOO" => "bar"}})

      assert updated.args == ["-y", "updated"]
      assert updated.env == %{"FOO" => "bar"}
      assert updated.id == s.id
    end
  end

  describe "delete/1" do
    test "removes the row" do
      {:ok, s} = Queries.create(%{project_id: nil, name: "del", type: "stdio", command: "npx"})
      assert :ok = Queries.delete(s.id)
      assert Queries.get_global(s.id) == :not_found
    end

    test "is idempotent for an unknown id" do
      assert :ok = Queries.delete(9_999_999)
    end
  end

  describe "get_global/1" do
    test "returns decoded row for a global row" do
      {:ok, s} = Queries.create(%{project_id: nil, name: "g", type: "stdio", command: "npx"})
      assert {:ok, fetched} = Queries.get_global(s.id)
      assert fetched.id == s.id
      assert fetched.project_id == nil
    end

    test "returns :not_found for a project-scoped row" do
      p = make_project()
      {:ok, s} = Queries.create(%{project_id: p.id, name: "scoped", type: "stdio", command: "npx"})
      assert Queries.get_global(s.id) == :not_found
    end

    test "returns :not_found for unknown id" do
      assert Queries.get_global(9_999_999) == :not_found
    end
  end

  describe "get_project/2" do
    test "returns decoded row matching project_id" do
      p = make_project()
      {:ok, s} = Queries.create(%{project_id: p.id, name: "scoped", type: "stdio", command: "npx"})
      assert {:ok, fetched} = Queries.get_project(p.id, s.id)
      assert fetched.id == s.id
      assert fetched.project_id == p.id
    end

    test "returns :not_found for a row not matching the given project_id" do
      p1 = make_project()
      p2 = make_project()
      {:ok, s} = Queries.create(%{project_id: p1.id, name: "scoped", type: "stdio", command: "npx"})
      assert Queries.get_project(p2.id, s.id) == :not_found
    end

    test "returns :not_found for a global row" do
      {:ok, s} = Queries.create(%{project_id: nil, name: "g2", type: "stdio", command: "npx"})
      assert Queries.get_project(1, s.id) == :not_found
    end
  end
end
