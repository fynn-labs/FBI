defmodule FBIWeb.Proxy.WebSocketTest do
  use ExUnit.Case, async: true

  alias FBIWeb.Proxy.WebSocket, as: WSProxy

  # ---------------------------------------------------------------------------
  # upgrade/2
  # ---------------------------------------------------------------------------

  describe "upgrade/2" do
    @tag :skip
    # upgrade/2 requires a live Bandit/Cowboy adapter to exercise
    # WebSockAdapter.upgrade/4 — covered by end-to-end fidelity tests.
    test "calls WebSockAdapter.upgrade and halts the conn" do
      :skipped
    end
  end

  # ---------------------------------------------------------------------------
  # init/1
  # ---------------------------------------------------------------------------

  describe "init/1" do
    test "returns {:stop, :shutdown, _} when upstream is unreachable" do
      state = %{
        target: "http://127.0.0.1:1",
        path: "/ws",
        upstream_headers: []
      }

      # Port 1 is reserved/unprivileged — nothing should be listening.
      assert {:stop, :shutdown, _} = WSProxy.init(state)
    end
  end

  # ---------------------------------------------------------------------------
  # handle_in/2
  # ---------------------------------------------------------------------------

  describe "handle_in/2" do
    test "drops frames silently when websock is nil (upgrade not yet complete)" do
      state = %{
        http_conn: nil,
        upstream_ref: nil,
        websock: nil,
        upstream_status: nil,
        upstream_headers_resp: []
      }

      assert {:ok, ^state} = WSProxy.handle_in({"hello", opcode: :text}, state)
    end

    test "drops binary frames silently when websock is nil" do
      state = %{
        http_conn: nil,
        upstream_ref: nil,
        websock: nil,
        upstream_status: nil,
        upstream_headers_resp: []
      }

      assert {:ok, ^state} = WSProxy.handle_in({<<0, 1, 2>>, opcode: :binary}, state)
    end
  end

  # ---------------------------------------------------------------------------
  # terminate/2
  # ---------------------------------------------------------------------------

  describe "terminate/2" do
    test "returns :ok without crashing when http_conn is nil" do
      state = %{http_conn: nil}
      assert :ok = WSProxy.terminate(:normal, state)
    end

    test "returns :ok without crashing when state has no http_conn key" do
      assert :ok = WSProxy.terminate(:shutdown, %{})
    end
  end
end
