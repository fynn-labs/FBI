defmodule FBIWeb.Proxy.WebSocket do
  @moduledoc """
  WebSocket reverse proxy. Accepts an inbound WS upgrade from the client,
  opens an outbound WS upgrade to a configured upstream, and pumps frames
  bidirectionally.

  Implementation: `Mint.WebSocket` for the outbound connection plus the
  `WebSock` behaviour for the inbound socket (Phoenix-blessed raw-WS).

  ## State

      %{
        http_conn: Mint.HTTP.t() | nil,    # connection to upstream
        upstream_ref: reference() | nil,   # Mint request ref for the upgrade
        websock: Mint.WebSocket.t() | nil, # WebSock state once 101 received
        upstream_status: integer() | nil,
        upstream_headers_resp: list()
      }

  ## Caveats

  * No backpressure handling — frames buffer in memory (Mint default). Fine
    for the modest PTY workload (~KB/s); revisit if usage spikes show
    memory pressure.
  * No WS extensions (e.g. permessage-deflate) negotiated. Reconsider if a
    client requires one.
  """

  @behaviour WebSock

  require Logger

  alias Mint.{HTTP, WebSocket}

  # Headers that Mint.WebSocket regenerates or are connection-specific.
  # Stripping them prevents conflicts with the upstream upgrade handshake.
  @strip_headers ~w(
    connection
    keep-alive
    upgrade
    sec-websocket-key
    sec-websocket-version
    sec-websocket-extensions
    sec-websocket-protocol
    host
  )

  # ---------------------------------------------------------------------------
  # Router entry point
  # ---------------------------------------------------------------------------

  @doc """
  Plug-compatible entry point for router dispatch. Upgrades the inbound
  `Plug.Conn` to a `WebSock` connection handled by this module.

  Required option:
    * `:target` — upstream base URL, e.g. `"http://127.0.0.1:3001"`.
  """
  @spec upgrade(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def upgrade(conn, opts) do
    target = Keyword.fetch!(opts, :target)
    path = conn.request_path <> query_suffix(conn)
    # Strip request headers that Mint.WebSocket regenerates and ones that
    # would corrupt the upstream upgrade handshake.
    headers = strip_proxy_headers(conn.req_headers)

    state = %{target: target, path: path, upstream_headers: headers}

    conn
    |> WebSockAdapter.upgrade(__MODULE__, state, timeout: 60_000)
    |> Plug.Conn.halt()
  end

  # ---------------------------------------------------------------------------
  # WebSock callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(%{target: target, path: path, upstream_headers: headers}) do
    uri = URI.parse(target)
    scheme = if uri.scheme in ["https", "wss"], do: :https, else: :http
    ws_scheme = if uri.scheme in ["https", "wss"], do: :wss, else: :ws
    port = uri.port || if(scheme == :https, do: 443, else: 80)

    # Open an HTTP connection to the upstream, then issue the WebSocket
    # upgrade request. Mint returns a request ref used to match responses.
    with {:ok, conn} <- HTTP.connect(scheme, uri.host, port),
         {:ok, conn, ref} <- WebSocket.upgrade(ws_scheme, conn, path, headers) do
      {:ok,
       %{
         http_conn: conn,
         upstream_ref: ref,
         websock: nil,
         upstream_status: nil,
         upstream_headers_resp: []
       }}
    else
      {:error, reason} ->
        Logger.warning("WS proxy upstream upgrade failed: #{inspect(reason)}")
        {:stop, :shutdown, %{http_conn: nil, upstream_ref: nil, websock: nil}}

      {:error, _conn, reason} ->
        Logger.warning("WS proxy upstream upgrade failed: #{inspect(reason)}")
        {:stop, :shutdown, %{http_conn: nil, upstream_ref: nil, websock: nil}}
    end
  end

  # client → us → upstream
  # An inbound frame arrived before the upstream upgrade completed. Drop it —
  # buffering with no bound is unsafe, and this is rare for Phoenix-bound
  # clients (the upstream 101 arrives quickly).
  @impl true
  def handle_in({_payload, opcode: _op}, %{websock: nil} = state) do
    {:ok, state}
  end

  def handle_in({payload, opcode: op}, state) do
    frame = inbound_frame(op, payload)

    case WebSocket.encode(state.websock, frame) do
      {:ok, ws, data} ->
        case WebSocket.stream_request_body(state.http_conn, state.upstream_ref, data) do
          {:ok, conn} ->
            {:ok, %{state | http_conn: conn, websock: ws}}

          {:error, conn, reason} ->
            Logger.warning("WS proxy upstream send error: #{inspect(reason)}")
            {:stop, :normal, %{state | http_conn: conn, websock: ws}}
        end

      {:error, ws, reason} ->
        Logger.warning("WS proxy encode error: #{inspect(reason)}")
        {:stop, :normal, %{state | websock: ws}}
    end
  end

  # upstream → us → client
  @impl true
  def handle_info(msg, state) do
    case WebSocket.stream(state.http_conn, msg) do
      {:ok, conn, responses} ->
        process_upstream(responses, %{state | http_conn: conn})

      {:error, conn, reason, _resps} ->
        Logger.warning("WS proxy upstream stream error: #{inspect(reason)}")
        {:stop, :normal, %{state | http_conn: conn}}

      :unknown ->
        {:ok, state}
    end
  end

  @impl true
  def terminate(_reason, %{http_conn: conn}) when not is_nil(conn) do
    HTTP.close(conn)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  # ---------------------------------------------------------------------------
  # process_upstream/2
  #
  # Walks the list of Mint response tuples for the upstream request ref,
  # accumulating :status and :headers until :done, then calling
  # WebSocket.new/4 to finalise the upgrade handshake. After the upgrade,
  # :data chunks are decoded into WebSocket frames which are pushed back
  # to the inbound client socket.
  # ---------------------------------------------------------------------------

  defp process_upstream([], state), do: {:ok, state}

  defp process_upstream([{:status, ref, status} | rest], %{upstream_ref: ref} = state) do
    process_upstream(rest, %{state | upstream_status: status})
  end

  defp process_upstream([{:headers, ref, headers} | rest], %{upstream_ref: ref} = state) do
    accumulated = state.upstream_headers_resp ++ headers
    process_upstream(rest, %{state | upstream_headers_resp: accumulated})
  end

  defp process_upstream([{:done, ref} | rest], %{upstream_ref: ref} = state) do
    case WebSocket.new(state.http_conn, ref, state.upstream_status, state.upstream_headers_resp) do
      {:ok, conn, ws} ->
        process_upstream(rest, %{state | http_conn: conn, websock: ws})

      {:error, conn, reason} ->
        Logger.warning("WS proxy upstream upgrade handshake failed: #{inspect(reason)}")
        {:stop, :normal, %{state | http_conn: conn}}
    end
  end

  defp process_upstream([{:data, ref, data} | rest], %{upstream_ref: ref} = state) do
    case WebSocket.decode(state.websock, data) do
      {:ok, ws, frames} ->
        messages = Enum.flat_map(frames, &map_upstream_frame/1)
        state = %{state | websock: ws}

        case process_upstream(rest, state) do
          {:ok, final_state} when messages == [] ->
            {:ok, final_state}

          {:ok, final_state} ->
            {:push, messages, final_state}

          # Propagate stop regardless of any buffered messages
          other ->
            other
        end

      {:error, ws, reason} ->
        Logger.warning("WS proxy decode error: #{inspect(reason)}")
        {:stop, :normal, %{state | websock: ws}}
    end
  end

  defp process_upstream([_other | rest], state) do
    process_upstream(rest, state)
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Maps a decoded upstream frame to the `{opcode, payload}` shape that
  # WebSock's {:push, messages, state} expects.
  defp map_upstream_frame({:text, payload}), do: [{:text, payload}]
  defp map_upstream_frame({:binary, payload}), do: [{:binary, payload}]
  defp map_upstream_frame({:ping, payload}), do: [{:ping, payload}]
  defp map_upstream_frame({:pong, payload}), do: [{:pong, payload}]
  defp map_upstream_frame({:close, code, reason}), do: [{:close, code, reason}]
  defp map_upstream_frame(_other), do: []

  # Maps an inbound client opcode + payload to a Mint.WebSocket frame tuple.
  defp inbound_frame(:text, payload), do: {:text, payload}
  defp inbound_frame(:binary, payload), do: {:binary, payload}
  defp inbound_frame(:ping, payload), do: {:ping, payload}
  defp inbound_frame(:pong, payload), do: {:pong, payload}

  # Returns "?<query_string>" when there is one, otherwise "".
  defp query_suffix(%Plug.Conn{query_string: ""}), do: ""
  defp query_suffix(%Plug.Conn{query_string: q}), do: "?" <> q

  # Strips headers that Mint.WebSocket will regenerate or that are
  # connection-specific and must not be forwarded to the upstream.
  defp strip_proxy_headers(headers) do
    Enum.reject(headers, fn {name, _value} ->
      String.downcase(name) in @strip_headers
    end)
  end
end
