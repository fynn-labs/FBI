defmodule FBI.Uploads.DraftTest do
  use ExUnit.Case, async: false
  alias FBI.Uploads.Draft

  setup do
    base = Path.join(System.tmp_dir!(), "fbi-draft-#{System.unique_integer([:positive])}")
    draft_dir = Path.join(base, "drafts")
    runs_dir = Path.join(base, "runs")
    File.mkdir_p!(draft_dir)
    File.mkdir_p!(runs_dir)

    on_exit(fn -> File.rm_rf(base) end)

    {:ok, draft_dir: draft_dir, runs_dir: runs_dir}
  end

  test "valid_token? matches 32 hex chars" do
    assert Draft.valid_token?("0123456789abcdef0123456789abcdef")
    refute Draft.valid_token?("xxx")
    refute Draft.valid_token?("0123456789ABCDEF0123456789ABCDEF")
    refute Draft.valid_token?(nil)
  end

  test "promote moves files and returns metadata", %{draft_dir: dd, runs_dir: rd} do
    token = "0123456789abcdef0123456789abcdef"
    src = Path.join(dd, token)
    File.mkdir_p!(src)
    File.write!(Path.join(src, "a.txt"), "hello")
    File.write!(Path.join(src, "b.tmp.part"), "skip me")

    assert {:ok, [%{filename: "a.txt", size: 5}]} = Draft.promote(dd, rd, token, 42)

    dst = Path.join([rd, "42", "uploads", "a.txt"])
    assert File.read!(dst) == "hello"
    refute File.exists?(src)
  end

  test "promote returns :error if token dir is missing", %{draft_dir: dd, runs_dir: rd} do
    assert {:error, _} = Draft.promote(dd, rd, "0123456789abcdef0123456789abcdef", 99)
  end
end
