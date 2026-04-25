defmodule FBI.Uploads.HumanSizeTest do
  use ExUnit.Case, async: true
  alias FBI.Uploads.HumanSize

  test "B for under 1 KiB" do
    assert HumanSize.format(0) == "0 B"
    assert HumanSize.format(1023) == "1023 B"
  end

  test "1 decimal for KB and MB" do
    assert HumanSize.format(1024) == "1.0 KB"
    assert HumanSize.format(1536) == "1.5 KB"
    assert HumanSize.format(1024 * 1024) == "1.0 MB"
    assert HumanSize.format(5 * 1024 * 1024 + 1024 * 512) == "5.5 MB"
  end

  test "2 decimals for GB tier" do
    assert HumanSize.format(2 * 1024 * 1024 * 1024) == "2.00 GB"
  end
end
