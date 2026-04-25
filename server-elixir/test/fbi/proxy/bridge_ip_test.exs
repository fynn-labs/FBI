defmodule FBI.Proxy.BridgeIpTest do
  use ExUnit.Case, async: true
  alias FBI.Proxy.BridgeIp

  test "returns direct IPAddress when present" do
    assert BridgeIp.pick(%{
             "NetworkSettings" => %{"IPAddress" => "172.17.0.2", "Networks" => %{}}
           }) ==
             "172.17.0.2"
  end

  test "iterates Networks for first non-empty IPAddress" do
    inspect = %{
      "NetworkSettings" => %{
        "IPAddress" => "",
        "Networks" => %{
          "host" => %{"IPAddress" => ""},
          "my-custom-net" => %{"IPAddress" => "10.0.0.5"},
          "bridge" => %{"IPAddress" => "172.17.0.2"}
        }
      }
    }

    # Returns *some* non-empty IP. Map order is undefined, so don't pin which one.
    assert BridgeIp.pick(inspect) in ["10.0.0.5", "172.17.0.2"]
  end

  test "returns nil when no IP available" do
    refute BridgeIp.pick(%{"NetworkSettings" => %{"IPAddress" => "", "Networks" => %{}}})
    refute BridgeIp.pick(%{"NetworkSettings" => %{"Networks" => nil}})
    refute BridgeIp.pick(nil)
  end
end
