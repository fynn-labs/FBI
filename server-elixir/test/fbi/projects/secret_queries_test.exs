defmodule FBI.Projects.SecretQueriesTest do
  use FBI.DataCase, async: false

  alias FBI.Projects.{Queries, SecretQueries}

  setup do
    key_path = Path.join(System.tmp_dir!(), "fbi-secret-test-#{System.unique_integer([:positive])}")
    File.write!(key_path, :crypto.strong_rand_bytes(32))
    prev = Application.get_env(:fbi, :secrets_key_path)
    Application.put_env(:fbi, :secrets_key_path, key_path)

    on_exit(fn ->
      if prev, do: Application.put_env(:fbi, :secrets_key_path, prev), else: Application.delete_env(:fbi, :secrets_key_path)
      File.rm(key_path)
    end)

    {:ok, p} = Queries.create(%{name: "p#{System.unique_integer([:positive])}", repo_url: "x"})
    %{project_id: p.id}
  end

  test "upsert and list round-trip names (values not exposed)", %{project_id: pid} do
    SecretQueries.upsert(pid, "FOO", "bar-value")
    assert [%{name: "FOO"}] = SecretQueries.list(pid)
  end

  test "upsert replaces value + created_at for existing name", %{project_id: pid} do
    SecretQueries.upsert(pid, "FOO", "first")
    [%{created_at: t1}] = SecretQueries.list(pid)
    :timer.sleep(2)
    SecretQueries.upsert(pid, "FOO", "second")
    [%{created_at: t2}] = SecretQueries.list(pid)
    assert t2 > t1
  end

  test "delete removes secret", %{project_id: pid} do
    SecretQueries.upsert(pid, "FOO", "bar")
    SecretQueries.delete(pid, "FOO")
    assert [] = SecretQueries.list(pid)
  end
end
