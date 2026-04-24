defmodule FBIWeb.Proxy.Http do
  @moduledoc """
  A `Plug` that reverse-proxies the current HTTP request to a target URL.

  This plug is stateless and per-request — it is not a GenServer. Each call
  reads the full request body, forwards the request (including method, path,
  query string, and non-hop-by-hop headers) to the target using `Req`, then
  writes the upstream response status, headers, and body back to the client.

  ## Hop-by-hop headers

  The following headers are stripped from both the forwarded request and the
  upstream response, per RFC 7230 §6.1, because they are meaningful only for a
  single transport hop and must not be blindly forwarded:

    * `connection`
    * `keep-alive`
    * `proxy-authenticate`
    * `proxy-authorization`
    * `te`
    * `trailer`
    * `transfer-encoding`
    * `upgrade`

  ## WebSocket upgrades

  This plug handles only request/response (HTTP/1.1 and HTTP/2) traffic.
  WebSocket upgrade requests should be handled by `FBIWeb.Proxy.WebSocket`,
  which manages the full bidirectional upgrade handshake separately.

  ## Options

    * `:target` (required) — base URL of the upstream server, e.g.
      `"http://127.0.0.1:3001"`. The request path and query string are
      appended automatically.
    * `:req_opts` (optional) — additional options merged into the `Req.request/1`
      call. Useful in tests for passing `plug: stub_fn` to intercept the HTTP
      call without a live server.
  """

  @behaviour Plug

  import Plug.Conn

  # RFC 7230 §6.1 hop-by-hop header names (lowercase).
  @hop_by_hop ~w(
    connection
    keep-alive
    proxy-authenticate
    proxy-authorization
    te
    trailer
    transfer-encoding
    upgrade
  )

  @impl true
  def init(opts), do: opts

  @impl true
  @doc """
  Proxies the request described by `conn` to the upstream target.

  Expected `opts` shape:
    * `target:` (required, string) — upstream base URL.
    * `req_opts:` (optional, keyword list) — extra options for `Req.request/1`.
  """
  def call(conn, opts) do
    target = Keyword.fetch!(opts, :target)
    req_opts = Keyword.get(opts, :req_opts, [])

    url = target <> conn.request_path <> query_suffix(conn)
    method = conn.method |> String.downcase() |> String.to_existing_atom()
    req_headers = strip_hop_by_hop(conn.req_headers)
    {body, conn} = read_body_full(conn)

    request_opts =
      Keyword.merge(
        [
          method: method,
          url: url,
          headers: req_headers,
          body: body,
          retry: false,
          decode_body: false
        ],
        req_opts
      )

    case Req.request(request_opts) do
      {:ok, %Req.Response{status: status, headers: resp_headers, body: resp_body}} ->
        conn
        |> put_response_headers(resp_headers)
        |> send_resp(status, resp_body || "")

      {:error, reason} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(502, Jason.encode!(%{error: "proxy_failed", reason: inspect(reason)}))
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Returns "?<query_string>" when there is a query string, otherwise "".
  defp query_suffix(%Plug.Conn{query_string: ""}), do: ""
  defp query_suffix(%Plug.Conn{query_string: q}), do: "?" <> q

  # Reads the full request body, accumulating chunks until `read_body/2`
  # signals `:ok` (no more data). Returns `{binary_body, conn}`.
  defp read_body_full(conn, acc \\ "") do
    case read_body(conn) do
      {:ok, chunk, conn} ->
        {:ok, conn} = {:ok, conn}
        {acc <> chunk, conn}

      {:more, chunk, conn} ->
        read_body_full(conn, acc <> chunk)
    end
  end

  # Removes hop-by-hop headers from a list of `{name, value}` pairs.
  # Comparison is case-insensitive (header names are already lowercase from
  # Plug, but we normalise to be safe).
  defp strip_hop_by_hop(headers) do
    Enum.reject(headers, fn {name, _value} ->
      String.downcase(name) in @hop_by_hop
    end)
  end

  # Copies upstream response headers onto `conn`, skipping hop-by-hop headers.
  #
  # Req returns headers as a map of `name => [values]` (current API). Some
  # test stubs or older Req versions may supply a flat list of `{name, value}`
  # pairs instead. Both shapes are handled here so the plug works in all
  # contexts without requiring callers to normalise their stubs.
  defp put_response_headers(conn, headers) when is_map(headers) do
    Enum.reduce(headers, conn, fn {name, values}, acc ->
      lower = String.downcase(name)

      if lower in @hop_by_hop do
        acc
      else
        # Each entry in the map is a list of values for that header name.
        Enum.reduce(List.wrap(values), acc, fn value, inner_acc ->
          put_resp_header(inner_acc, lower, value)
        end)
      end
    end)
  end

  defp put_response_headers(conn, headers) when is_list(headers) do
    Enum.reduce(headers, conn, fn {name, value}, acc ->
      lower = String.downcase(name)

      if lower in @hop_by_hop do
        acc
      else
        put_resp_header(acc, lower, value)
      end
    end)
  end
end
