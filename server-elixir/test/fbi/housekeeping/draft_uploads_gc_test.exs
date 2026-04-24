defmodule FBI.Housekeeping.DraftUploadsGcTest do
  use ExUnit.Case, async: false

  alias FBI.Housekeeping.DraftUploadsGc

  # 25 hours
  @aged_ms 25 * 60 * 60 * 1000

  defp mk_dir_with_age(parent, name, age_ms) do
    dir = Path.join(parent, name)
    File.mkdir_p!(dir)

    # set mtime well in the past
    age_secs = div(age_ms, 1000)
    target = System.os_time(:second) - age_secs
    :ok = File.touch!(dir, target)
    dir
  end

  describe "sweep_draft_uploads/1" do
    test "removes dirs older than 24 hours" do
      parent = Path.join(System.tmp_dir!(), "fbi-gc-test-#{System.unique_integer([:positive])}")
      File.mkdir_p!(parent)
      on_exit(fn -> File.rm_rf(parent) end)

      aged = mk_dir_with_age(parent, "aged", @aged_ms)
      young = mk_dir_with_age(parent, "young", 60_000)

      DraftUploadsGc.sweep_draft_uploads(parent)

      refute File.exists?(aged)
      assert File.exists?(young)
    end

    test "no-op for missing directory" do
      DraftUploadsGc.sweep_draft_uploads(
        Path.join(System.tmp_dir!(), "does-not-exist-#{System.unique_integer([:positive])}")
      )
    end
  end

  describe "sweep_part_files/1" do
    test "removes .part files in run-upload subdirs" do
      parent = Path.join(System.tmp_dir!(), "fbi-runs-gc-#{System.unique_integer([:positive])}")
      uploads = Path.join([parent, "42", "uploads"])
      File.mkdir_p!(uploads)
      on_exit(fn -> File.rm_rf(parent) end)

      File.write!(Path.join(uploads, "normal.txt"), "x")
      File.write!(Path.join(uploads, "partial.part"), "y")

      DraftUploadsGc.sweep_part_files(parent)

      assert File.exists?(Path.join(uploads, "normal.txt"))
      refute File.exists?(Path.join(uploads, "partial.part"))
    end
  end
end
