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

  describe "parse_compare/1" do
    test "parses gh compare JSON into the expected shape" do
      json = ~s|{
        "ahead_by": 3,
        "behind_by": 1,
        "merge_base_commit": {"sha": "deadbeef"},
        "commits": [
          {"sha": "abc123", "commit": {"message": "first\\nbody", "committer": {"date": "2026-04-25T12:00:00Z"}}},
          {"sha": "def456", "commit": {"message": "second", "committer": {"date": "2026-04-25T13:00:00Z"}}}
        ]
      }|

      assert {:ok, parsed} = Client.parse_compare(json)
      assert parsed.ahead_by == 3
      assert parsed.behind_by == 1
      assert parsed.merge_base_sha == "deadbeef"
      assert [%{sha: "abc123", subject: "first", pushed: true}, _] = parsed.commits
    end

    test "returns empty defaults on malformed JSON" do
      assert {:ok, %{commits: [], ahead_by: 0, behind_by: 0, merge_base_sha: ""}} =
               Client.parse_compare("not json")
    end

    test "handles missing keys gracefully" do
      assert {:ok, parsed} = Client.parse_compare("{}")
      assert parsed.commits == []
      assert parsed.ahead_by == 0
      assert parsed.behind_by == 0
      assert parsed.merge_base_sha == ""
    end
  end

  describe "compare_branch/3" do
    test "calls gh api with encoded base...head and returns parsed shape" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn args ->
        assert ["api", url] = args
        assert url == "repos/a/b/compare/main...feature%2Fx"

        {:ok,
         Jason.encode!(%{
           "ahead_by" => 2,
           "behind_by" => 0,
           "merge_base_commit" => %{"sha" => "mb"},
           "commits" => [
             %{
               "sha" => "s1",
               "commit" => %{
                 "message" => "subj\nbody",
                 "committer" => %{"date" => "2026-04-25T12:00:00Z"}
               }
             }
           ]
         })}
      end)

      assert {:ok, parsed} = Client.compare_branch("a/b", "main", "feature/x")
      assert parsed.ahead_by == 2
      assert parsed.merge_base_sha == "mb"
      assert [%{sha: "s1", subject: "subj"}] = parsed.commits
    end

    test "propagates gh errors" do
      Application.put_env(:fbi, :gh_cmd_adapter, fn _args -> {:error, {1, "boom"}} end)
      assert {:error, {1, "boom"}} = Client.compare_branch("a/b", "main", "feature")
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
