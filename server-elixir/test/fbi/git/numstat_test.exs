defmodule FBI.Git.NumstatTest do
  use ExUnit.Case, async: true
  alias FBI.Git.Numstat

  test "parses additions-only line as A" do
    assert [%{path: "foo.txt", status: "A", additions: 10, deletions: 0}] =
             Numstat.parse("10\t0\tfoo.txt\n")
  end

  test "parses deletions-only line as D" do
    assert [%{path: "bar.txt", status: "D", additions: 0, deletions: 5}] =
             Numstat.parse("0\t5\tbar.txt\n")
  end

  test "parses mixed line as M" do
    assert [%{path: "x.txt", status: "M", additions: 3, deletions: 4}] =
             Numstat.parse("3\t4\tx.txt\n")
  end

  test "binary file -\\t- maps to M with zero counts" do
    assert [%{path: "blob.bin", status: "M", additions: 0, deletions: 0}] =
             Numstat.parse("-\t-\tblob.bin\n")
  end

  test "ignores malformed lines" do
    text = "garbage\n\n10\t0\tok.txt\nincomplete\t\n"
    assert [%{path: "ok.txt"}] = Numstat.parse(text)
  end

  test "empty input yields empty list" do
    assert Numstat.parse("") == []
  end
end
