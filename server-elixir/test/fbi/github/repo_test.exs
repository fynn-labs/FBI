defmodule FBI.Github.RepoTest do
  use ExUnit.Case, async: true

  alias FBI.Github.Repo

  test "parses git@ URLs" do
    assert {:ok, "a/b"} = Repo.parse("git@github.com:a/b.git")
    assert {:ok, "a/b"} = Repo.parse("git@github.com:a/b")
  end

  test "parses https URLs" do
    assert {:ok, "a/b"} = Repo.parse("https://github.com/a/b.git")
    assert {:ok, "a/b"} = Repo.parse("https://github.com/a/b")
    assert {:ok, "a/b"} = Repo.parse("http://github.com/a/b/")
  end

  test ":error for non-github or garbage input" do
    assert :error = Repo.parse(nil)
    assert :error = Repo.parse("")
    assert :error = Repo.parse("not-a-url")
    assert :error = Repo.parse("git@gitlab.com:a/b.git")
  end
end
