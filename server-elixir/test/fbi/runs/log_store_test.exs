defmodule FBI.Runs.LogStoreTest do
  use ExUnit.Case, async: true
  alias FBI.Runs.LogStore

  setup do
    path = Path.join(System.tmp_dir!(), "fbi_log_#{:rand.uniform(999_999)}.log")
    on_exit(fn -> File.rm(path) end)
    {:ok, path: path}
  end

  test "open/append/close round-trip", %{path: path} do
    store = LogStore.open(path)
    LogStore.append(store, "hello ")
    LogStore.append(store, "world")
    LogStore.close(store)
    assert LogStore.read_all(path) == "hello world"
  end

  test "byte_size/1", %{path: path} do
    File.write!(path, "abcde")
    assert LogStore.byte_size(path) == 5
  end

  test "byte_size/1 returns 0 for missing file" do
    assert LogStore.byte_size("/tmp/nonexistent_fbi_log.log") == 0
  end

  test "read_range/3", %{path: path} do
    File.write!(path, "0123456789")
    assert LogStore.read_range(path, 2, 5) == "2345"
  end

  test "read_all/1 returns empty binary for missing file" do
    assert LogStore.read_all("/tmp/nonexistent.log") == ""
  end
end
