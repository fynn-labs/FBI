defmodule FBI.Proxy.ProcListenersTest do
  use ExUnit.Case, async: true
  alias FBI.Proxy.ProcListeners

  test "parses listening sockets, ignores non-LISTEN" do
    text = """
      sl  local_address rem_address   st ...
       0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1
       1: 0100007F:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 1
       2: 0100007F:1FFE 0100007F:1234 0A 00000000:00000000 00:00000000 00000000     0        0 1
    """

    assert ProcListeners.parse(text) == [
             %{port: 8080, proto: :tcp},
             %{port: 8190, proto: :tcp}
           ]
  end

  test "deduplicates and sorts" do
    text = """
       0: 0100007F:1F90 00000000:0000 0A
       1: 0100007F:1F90 00000000:0000 0A
       2: 0100007F:1F8F 00000000:0000 0A
    """

    assert ProcListeners.parse(text) == [
             %{port: 8079, proto: :tcp},
             %{port: 8080, proto: :tcp}
           ]
  end

  test "rejects ports outside 1..65535" do
    text = "  0: 0100007F:0000 00000000:0000 0A\n  1: 0100007F:FFFF 00000000:0000 0A\n"
    assert ProcListeners.parse(text) == [%{port: 65535, proto: :tcp}]
  end
end
