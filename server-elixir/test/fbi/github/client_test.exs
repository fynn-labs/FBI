defmodule FBI.Github.ClientTest do
  use ExUnit.Case, async: false

  alias FBI.Github.Client

  setup do
    prev = Application.get_env(:fbi, :gh_cmd_adapter)

    on_exit(fn ->
      if prev do
        Application.put_env(:fbi, :gh_cmd_adapter, prev)
      else
        Application.delete_env(:fbi, :gh_cmd_adapter)
      end
    end)

    :ok
  end

  describe "pr_for_branch/2" do
    test "returns {:ok, nil} when gh prints []" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:ok, "[]"} end)
      assert {:ok, nil} = Client.pr_for_branch("a/b", "main")
    end

    test "atomizes the PR shape" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        {:ok,
         Jason.encode!([
           %{"number" => 42, "url" => "https://x", "state" => "OPEN", "title" => "hi"}
         ])}
      end)

      assert {:ok, %{number: 42, url: "https://x", state: "OPEN", title: "hi"}} =
               Client.pr_for_branch("a/b", "main")
    end

    test "propagates gh errors" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:error, {1, "boom"}} end)
      assert {:error, {1, "boom"}} = Client.pr_for_branch("a/b", "main")
    end
  end

  describe "pr_checks/2" do
    test "returns parsed list on success" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        {:ok,
         Jason.encode!([%{"name" => "ci", "status" => "completed", "conclusion" => "success"}])}
      end)

      assert {:ok, [%{"name" => "ci"}]} = Client.pr_checks("a/b", "main")
    end
  end

  describe "commits_on_branch/2" do
    test "maps commit objects into compact form" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        {:ok,
         Jason.encode!([
           %{
             "sha" => "abc123",
             "commit" => %{
               "message" => "first line\nbody here",
               "committer" => %{"date" => "2026-04-24T10:00:00Z"}
             }
           }
         ])}
      end)

      assert {:ok, [commit]} = Client.commits_on_branch("a/b", "main")
      assert commit.sha == "abc123"
      assert commit.subject == "first line"
      assert is_integer(commit.committed_at)
      assert commit.pushed == true
    end
  end

  describe "merge_branch/4" do
    test "returns already_merged on empty stdout" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:ok, ""} end)

      assert {:ok, %{merged: false, reason: :already_merged}} =
               Client.merge_branch("a/b", "feature", "main", "msg")
    end

    test "returns merged: true with sha on success" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        {:ok, Jason.encode!(%{"sha" => "xyz"})}
      end)

      assert {:ok, %{merged: true, sha: "xyz"}} =
               Client.merge_branch("a/b", "feature", "main", "msg")
    end

    test "maps 409/conflict-stderr to conflict" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args ->
        {:error, {1, "merge conflict occurred"}}
      end)

      assert {:ok, %{merged: false, reason: :conflict}} =
               Client.merge_branch("a/b", "feature", "main", "msg")
    end

    test "other gh errors map to :gh_error" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:error, {2, "network"}} end)
      assert {:error, :gh_error} = Client.merge_branch("a/b", "feature", "main", "msg")
    end
  end
end
