defmodule FBIWeb.Proxy.HttpTest do
  use ExUnit.Case, async: true

  import Plug.Test
  import Plug.Conn

  alias FBIWeb.Proxy.Http

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  # Builds a Plug.Test conn and runs it through the proxy plug with a stub.
  # `stub` must be a 1-arity function that receives a Plug.Conn (built by Req
  # from the outgoing request) and returns a Plug.Conn with send_resp called.
  defp proxy_call(method, path, body, stub, extra_opts \\ []) do
    conn = conn(method, path, body)

    opts =
      Http.init(
        Keyword.merge(
          [target: "http://127.0.0.1:3001", req_opts: [plug: stub]],
          extra_opts
        )
      )

    Http.call(conn, opts)
  end

  # ---------------------------------------------------------------------------
  # Tests
  # ---------------------------------------------------------------------------

  describe "GET forwarding" do
    test "forwards GET and returns 200 with body" do
      stub = fn conn ->
        send_resp(conn, 200, "hello")
      end

      result = proxy_call(:get, "/some/path", "", stub)

      assert result.status == 200
      assert result.resp_body == "hello"
    end
  end

  describe "POST forwarding" do
    test "forwards POST body to upstream" do
      {:ok, agent} = Agent.start_link(fn -> nil end)

      stub = fn conn ->
        {:ok, body, conn} = read_body(conn)
        Agent.update(agent, fn _ -> body end)
        send_resp(conn, 200, "ok")
      end

      proxy_call(:post, "/api/data", "my-body", stub)

      assert Agent.get(agent, & &1) == "my-body"
    end
  end

  describe "request header forwarding" do
    test "forwards custom headers to upstream" do
      {:ok, agent} = Agent.start_link(fn -> nil end)

      stub = fn conn ->
        Agent.update(agent, fn _ -> conn.req_headers end)
        send_resp(conn, 200, "")
      end

      request_conn = conn(:get, "/test")
      request_conn = put_req_header(request_conn, "x-custom", "hi")

      opts = Http.init(target: "http://127.0.0.1:3001", req_opts: [plug: stub])
      Http.call(request_conn, opts)

      header_names = agent |> Agent.get(& &1) |> Enum.map(fn {k, _} -> k end)
      assert "x-custom" in header_names
    end

    test "strips hop-by-hop headers from request (connection: keep-alive)" do
      {:ok, agent} = Agent.start_link(fn -> nil end)

      stub = fn conn ->
        Agent.update(agent, fn _ -> conn.req_headers end)
        send_resp(conn, 200, "")
      end

      request_conn = conn(:get, "/test")
      request_conn = put_req_header(request_conn, "connection", "keep-alive")
      request_conn = put_req_header(request_conn, "x-custom", "hi")

      opts = Http.init(target: "http://127.0.0.1:3001", req_opts: [plug: stub])
      Http.call(request_conn, opts)

      header_names = agent |> Agent.get(& &1) |> Enum.map(fn {k, _} -> k end)
      refute "connection" in header_names
      assert "x-custom" in header_names
    end

    test "strips transfer-encoding from request headers" do
      {:ok, agent} = Agent.start_link(fn -> nil end)

      stub = fn conn ->
        Agent.update(agent, fn _ -> conn.req_headers end)
        send_resp(conn, 200, "")
      end

      request_conn = conn(:get, "/test")
      request_conn = put_req_header(request_conn, "transfer-encoding", "chunked")

      opts = Http.init(target: "http://127.0.0.1:3001", req_opts: [plug: stub])
      Http.call(request_conn, opts)

      header_names = agent |> Agent.get(& &1) |> Enum.map(fn {k, _} -> k end)
      refute "transfer-encoding" in header_names
    end
  end

  describe "response status and headers" do
    test "preserves non-200 response status" do
      stub = fn conn ->
        conn
        |> put_resp_header("x-special", "yes")
        |> send_resp(201, "created")
      end

      result = proxy_call(:post, "/things", "", stub)
      assert result.status == 201
    end

    test "preserves custom response headers" do
      stub = fn conn ->
        conn
        |> put_resp_header("x-special", "yes")
        |> send_resp(201, "created")
      end

      result = proxy_call(:post, "/things", "", stub)
      assert get_resp_header(result, "x-special") == ["yes"]
    end

    test "strips hop-by-hop headers from response (transfer-encoding: chunked)" do
      stub = fn conn ->
        conn
        |> put_resp_header("transfer-encoding", "chunked")
        |> put_resp_header("x-ok", "yes")
        |> send_resp(200, "body")
      end

      result = proxy_call(:get, "/test", "", stub)
      assert get_resp_header(result, "transfer-encoding") == []
      assert get_resp_header(result, "x-ok") == ["yes"]
    end

    test "handles response headers as flat list of {name, value} pairs" do
      # Verifies put_response_headers/2 handles the list-of-tuples shape that
      # older Req versions or certain test stubs may produce.
      stub = fn conn ->
        conn
        |> put_resp_header("x-list", "val")
        |> send_resp(200, "ok")
      end

      result = proxy_call(:get, "/test", "", stub)
      assert result.status == 200
      assert get_resp_header(result, "x-list") == ["val"]
    end
  end

  describe "query string preservation" do
    test "appends query string to upstream URL" do
      {:ok, agent} = Agent.start_link(fn -> nil end)

      stub = fn conn ->
        # Req builds a full URI on the conn; reconstruct it to check the query.
        uri = %URI{
          scheme: to_string(conn.scheme),
          host: conn.host,
          port: conn.port,
          path: conn.request_path,
          query: conn.query_string
        }

        Agent.update(agent, fn _ -> URI.to_string(uri) end)
        send_resp(conn, 200, "")
      end

      proxy_call(:get, "/api/foo?a=1&b=2", "", stub)

      captured_url = Agent.get(agent, & &1)
      assert String.contains?(captured_url, "?a=1&b=2")
    end

    test "does not append query string when none is present" do
      {:ok, agent} = Agent.start_link(fn -> nil end)

      stub = fn conn ->
        Agent.update(agent, fn _ -> conn.query_string end)
        send_resp(conn, 200, "")
      end

      proxy_call(:get, "/api/foo", "", stub)

      assert Agent.get(agent, & &1) == ""
    end
  end

  describe "error handling" do
    test "returns 502 with JSON error body when upstream errors" do
      # Req.Test.transport_error puts the error in conn private so Req
      # surfaces it as {:error, reason} to our plug.
      stub = fn conn ->
        Req.Test.transport_error(conn, :econnrefused)
      end

      result = proxy_call(:get, "/bad", "", stub)

      assert result.status == 502
      body = Jason.decode!(result.resp_body)
      assert body["error"] == "proxy_failed"
      assert is_binary(body["reason"])
    end
  end
end
