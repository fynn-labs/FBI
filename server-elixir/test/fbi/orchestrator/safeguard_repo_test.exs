defmodule FBI.Orchestrator.SafeguardRepoTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.SafeguardRepo

  setup do
    dir = Path.join(System.tmp_dir!(), "fbi_sr_#{:rand.uniform(999_999)}.git")
    File.mkdir_p!(dir)
    System.cmd("git", ~w[init --bare --initial-branch main] ++ [dir])
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir}
  end

  test "exists?/1 true for initialised bare repo", %{dir: dir} do
    assert SafeguardRepo.exists?(dir)
  end

  test "exists?/1 false for missing dir" do
    refute SafeguardRepo.exists?("/tmp/nonexistent_sr_xyz")
  end

  test "head/2 returns nil when no commits", %{dir: dir} do
    assert SafeguardRepo.head(dir, "main") == nil
  end

  test "list_commits/3 returns empty list when no commits", %{dir: dir} do
    assert SafeguardRepo.list_commits(dir, "main", "") == []
  end
end
