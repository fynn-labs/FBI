defmodule FBIWeb.ProxyRouterTest do
  use ExUnit.Case, async: true

  import Plug.Test
  import Plug.Conn

  alias FBIWeb.ProxyRouter

  # ---------------------------------------------------------------------------
  # websocket_upgrade? predicate — tested indirectly via call/2 behaviour
  # and directly by inspecting headers on a test conn.
  # ---------------------------------------------------------------------------

  describe "WebSocket detection" do
    test "routes request with Upgrade: websocket to the WebSocket proxy path" do
      # WebSockAdapter.upgrade/4 validates the host header before it proceeds.
      # A missing or wrong host causes an UpgradeError which confirms the WS
      # branch was taken — the HTTP proxy path would return 502 instead.
      Application.put_env(:fbi, :proxy_target, "http://127.0.0.1:19999")

      ws_conn =
        conn(:get, "/ws/test")
        |> put_req_header("upgrade", "websocket")
        |> put_req_header("connection", "upgrade")
        |> put_req_header("sec-websocket-version", "13")
        |> put_req_header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")

      # The WS proxy is reached — it raises UpgradeError (not returning 502).
      assert_raise WebSockAdapter.UpgradeError, fn ->
        ProxyRouter.call(ws_conn, [])
      end
    end

    test "routes request with Upgrade: WebSocket (mixed-case) to the WebSocket proxy path" do
      Application.put_env(:fbi, :proxy_target, "http://127.0.0.1:19999")

      ws_conn =
        conn(:get, "/ws/mixed")
        |> put_req_header("upgrade", "WebSocket")
        |> put_req_header("connection", "upgrade")
        |> put_req_header("sec-websocket-version", "13")
        |> put_req_header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")

      assert_raise WebSockAdapter.UpgradeError, fn ->
        ProxyRouter.call(ws_conn, [])
      end
    end

    test "plain HTTP request with no Upgrade header routes to HTTP proxy" do
      Application.put_env(:fbi, :proxy_target, "http://127.0.0.1:19999")

      plain_conn = conn(:get, "/api/projects")
      result = ProxyRouter.call(plain_conn, [])

      # HTTP proxy returns 502 when the upstream is unreachable.
      assert result.status == 502
      body = Jason.decode!(result.resp_body)
      assert body["error"] == "proxy_failed"
    end
  end

  # ---------------------------------------------------------------------------
  # dispatch/2 — Phoenix calls the action via dispatch, not call directly.
  # ---------------------------------------------------------------------------

  describe "dispatch/2" do
    test "dispatch delegates to call and returns 502 for unreachable HTTP target" do
      Application.put_env(:fbi, :proxy_target, "http://127.0.0.1:19999")

      result = ProxyRouter.dispatch(conn(:get, "/some/path"), [])

      assert result.status == 502
    end
  end
end
