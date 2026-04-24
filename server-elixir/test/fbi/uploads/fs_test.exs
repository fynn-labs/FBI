defmodule FBI.Uploads.FSTest do
  use ExUnit.Case, async: true

  alias FBI.Uploads.FS

  describe "sanitize_filename/1" do
    test "accepts normal filenames" do
      assert {:ok, "foo.txt"} = FS.sanitize_filename("foo.txt")
      assert {:ok, "report 2024.pdf"} = FS.sanitize_filename("report 2024.pdf")
      assert {:ok, "a-b_c.md"} = FS.sanitize_filename("a-b_c.md")
    end

    test "trims surrounding whitespace" do
      assert {:ok, "foo.txt"} = FS.sanitize_filename("  foo.txt  ")
    end

    test "rejects empty string" do
      assert {:error, :invalid} = FS.sanitize_filename("")
      assert {:error, :invalid} = FS.sanitize_filename("   ")
    end

    test "rejects '.'" do
      assert {:error, :invalid} = FS.sanitize_filename(".")
    end

    test "rejects '..'" do
      assert {:error, :invalid} = FS.sanitize_filename("..")
    end

    test "rejects names starting with '..'" do
      assert {:error, :invalid} = FS.sanitize_filename("..evil")
      assert {:error, :invalid} = FS.sanitize_filename("../foo")
    end

    test "rejects forward slash" do
      assert {:error, :invalid} = FS.sanitize_filename("foo/bar")
    end

    test "rejects backslash" do
      assert {:error, :invalid} = FS.sanitize_filename("foo\\bar")
    end

    test "rejects NULL byte" do
      assert {:error, :invalid} = FS.sanitize_filename("foo\x00bar")
    end

    test "rejects names longer than 255 bytes" do
      long = String.duplicate("a", 256)
      assert {:error, :invalid} = FS.sanitize_filename(long)
    end

    test "accepts names exactly 255 bytes" do
      s = String.duplicate("a", 255)
      assert {:ok, ^s} = FS.sanitize_filename(s)
    end

    test "rejects non-string inputs" do
      assert {:error, :invalid} = FS.sanitize_filename(42)
      assert {:error, :invalid} = FS.sanitize_filename(nil)
      assert {:error, :invalid} = FS.sanitize_filename(%{})
      assert {:error, :invalid} = FS.sanitize_filename([])
    end
  end

  describe "resolve_filename/2" do
    setup do
      dir = Path.join(System.tmp_dir!(), "fbi-fs-test-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf(dir) end)
      {:ok, dir: dir}
    end

    test "returns filename unchanged when no collision", %{dir: dir} do
      assert {:ok, "foo.txt"} = FS.resolve_filename(dir, "foo.txt")
    end

    test "returns 'foo (1).txt' on first collision", %{dir: dir} do
      File.write!(Path.join(dir, "foo.txt"), "x")
      assert {:ok, "foo (1).txt"} = FS.resolve_filename(dir, "foo.txt")
    end

    test "returns 'foo (2).txt' on second collision", %{dir: dir} do
      File.write!(Path.join(dir, "foo.txt"), "x")
      File.write!(Path.join(dir, "foo (1).txt"), "x")
      assert {:ok, "foo (2).txt"} = FS.resolve_filename(dir, "foo.txt")
    end

    test "handles filenames with no extension", %{dir: dir} do
      File.write!(Path.join(dir, "README"), "x")
      assert {:ok, "README (1)"} = FS.resolve_filename(dir, "README")
    end
  end

  describe "directory_bytes/1" do
    test "returns 0 for nonexistent directory" do
      missing =
        Path.join(System.tmp_dir!(), "fbi-fs-missing-#{System.unique_integer([:positive])}")

      assert FS.directory_bytes(missing) == 0
    end

    test "returns 0 for empty directory" do
      dir = Path.join(System.tmp_dir!(), "fbi-fs-empty-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf(dir) end)
      assert FS.directory_bytes(dir) == 0
    end

    test "returns total bytes across regular files; ignores subdirs" do
      dir = Path.join(System.tmp_dir!(), "fbi-fs-mixed-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf(dir) end)

      File.write!(Path.join(dir, "a.txt"), "abc")
      File.write!(Path.join(dir, "b.txt"), "defghij")

      sub = Path.join(dir, "sub")
      File.mkdir_p!(sub)
      # File inside subdir should NOT be counted (we only stat direct entries).
      File.write!(Path.join(sub, "c.txt"), "zzzzz")

      assert FS.directory_bytes(dir) == 3 + 7
    end
  end

  describe "draft_token/0" do
    test "returns a 32-char hex string" do
      t = FS.draft_token()
      assert is_binary(t)
      assert byte_size(t) == 32
      assert Regex.match?(~r/^[0-9a-f]{32}$/, t)
    end

    test "returns a different token on each call" do
      refute FS.draft_token() == FS.draft_token()
    end
  end

  describe "valid_draft_token?/1" do
    test "accepts a 32-char lowercase hex string" do
      assert FS.valid_draft_token?(String.duplicate("a", 32))
      assert FS.valid_draft_token?("0123456789abcdef0123456789abcdef")
    end

    test "rejects uppercase hex" do
      refute FS.valid_draft_token?(String.duplicate("A", 32))
    end

    test "rejects wrong length" do
      refute FS.valid_draft_token?(String.duplicate("a", 31))
      refute FS.valid_draft_token?(String.duplicate("a", 33))
      refute FS.valid_draft_token?("")
    end

    test "rejects non-hex chars" do
      refute FS.valid_draft_token?(String.duplicate("g", 32))
    end

    test "rejects non-binary input" do
      refute FS.valid_draft_token?(nil)
      refute FS.valid_draft_token?(123)
      refute FS.valid_draft_token?(%{})
    end
  end
end
