defmodule FBI.Orchestrator.WipRepoTest do
  use ExUnit.Case, async: true

  alias FBI.Orchestrator.WipRepo

  setup do
    base = Path.join(System.tmp_dir!(), "fbi_wip_#{:rand.uniform(999_999)}")
    File.mkdir_p!(base)
    on_exit(fn -> File.rm_rf(base) end)
    {:ok, base: base}
  end

  test "path/2 returns <base>/<id>/wip.git", %{base: base} do
    assert WipRepo.path(base, 42) == Path.join(base, "42/wip.git")
  end

  test "exists?/2 returns false before init", %{base: base} do
    refute WipRepo.exists?(base, 1)
  end

  test "init/2 creates a bare repo", %{base: base} do
    WipRepo.init(base, 1)
    assert WipRepo.exists?(base, 1)
    assert File.exists?(Path.join(base, "1/wip.git/HEAD"))
  end

  test "init/2 is idempotent", %{base: base} do
    WipRepo.init(base, 1)
    WipRepo.init(base, 1)
    assert WipRepo.exists?(base, 1)
  end

  test "remove/2 deletes the repo", %{base: base} do
    WipRepo.init(base, 1)
    WipRepo.remove(base, 1)
    refute WipRepo.exists?(base, 1)
  end

  test "snapshot_sha/2 returns nil on empty repo", %{base: base} do
    WipRepo.init(base, 1)
    assert WipRepo.snapshot_sha(base, 1) == nil
  end
end
