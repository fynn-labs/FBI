defmodule FBIWeb.Sockets.UsageWSHandler do
  @moduledoc """
  Raw WebSocket handler for `/api/ws/usage`.

  Why raw `WebSock` instead of a Phoenix Channel: the React client speaks plain
  JSON over a bare WebSocket connection. Phoenix Channels wrap every message in a
  multi-element array envelope (`[join_ref, ref, topic, event, payload]`) that
  the client does not parse. Using the `WebSock` behaviour via `WebSockAdapter`
  lets us send and receive plain JSON text frames with no envelope overhead.

  ## Lifecycle

  1. On connect, the handler subscribes to the `"usage"` PubSub topic so it
     receives all broadcasts from `FBI.Usage.Poller`.
  2. The current snapshot is fetched via `FBI.Usage.Poller.snapshot/0` and
     immediately pushed as a JSON text frame so the client has data without
     waiting for the next poll cycle.
  3. Subsequent broadcasts from the poller — both `snapshot` and
     `threshold_crossed` messages — are forwarded as JSON text frames as they
     arrive.
  """

  @behaviour WebSock

  import Plug.Conn

  @doc "Plug-compatible entry point that performs the WS upgrade and hands off to this WebSock handler."
  def upgrade(conn, _opts) do
    conn
    |> WebSockAdapter.upgrade(__MODULE__, %{}, timeout: 60_000)
    |> halt()
  end

  @impl true
  def init(_state) do
    Phoenix.PubSub.subscribe(FBI.PubSub, "usage")
    snapshot_msg = %{type: "snapshot", state: FBI.Usage.Poller.snapshot()}
    {:push, {:text, Jason.encode!(snapshot_msg)}, %{}}
  end

  @impl true
  def handle_in(_frame, state), do: {:ok, state}

  # Both snapshot (%{type: "snapshot", state: ...}) and threshold_crossed
  # (%{type: "threshold_crossed", ...}) messages from the poller share a
  # `:type` key. This single broad clause forwards either shape as a JSON
  # text frame without needing separate match arms for each message type.
  @impl true
  def handle_info(%{type: _} = msg, state) do
    {:push, {:text, Jason.encode!(msg)}, state}
  end

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, _state), do: :ok
end
