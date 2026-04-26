defmodule FBIWeb.Sockets.ShellWSHandler do
  @moduledoc """
  WebSock handler for /api/runs/:id/shell.

  Protocol (see spec §6 of 2026-04-26-terminal-rust-rewrite-design.md):

    C→S text:
      {"type":"hello", "cols":N, "rows":M}     accepted any time
      {"type":"resize", "cols":N, "rows":M}    same routing as hello, no reply
      {"type":"focus"}                         viewer asserts ownership
      {"type":"blur"}                          viewer relinquishes
    C→S binary:
      raw stdin bytes (synthesizes focus first if not focused)
    S→C text:
      {"type":"snapshot", "ansi":..., "cols":N, "rows":M}
      {"type":"focus_state", "focused":bool, "by_self":bool}
      typed events: usage / state / title / changes (via :events PubSub)
    S→C binary:
      raw PTY bytes (via :bytes PubSub)
  """
  @behaviour WebSock

  alias FBI.Orchestrator

  @impl true
  def init(%{run_id: run_id}) do
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:bytes")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:events")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:state")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:snapshot")
    {:ok, %{run_id: run_id, viewer_id: nil, is_focused: false}}
  end

  # ----- text frames -----

  @impl true
  def handle_in({text, [opcode: :text]}, %{run_id: run_id} = state) do
    case Jason.decode(text) do
      {:ok, %{"type" => "hello", "cols" => cols, "rows" => rows}}
      when is_integer(cols) and is_integer(rows) ->
        state = ensure_registered_or_resize(state, cols, rows)
        # Reply to THIS viewer with the current snapshot, regardless of
        # focus state. Driving viewer's resize broadcast (if any) is
        # handled inside RunServer.
        snap = Orchestrator.snapshot(run_id)
        frame =
          Jason.encode!(%{
            type: "snapshot",
            ansi: snap.ansi,
            cols: snap.cols,
            rows: snap.rows
          })
        {:push, {:text, frame}, state}

      {:ok, %{"type" => "resize", "cols" => cols, "rows" => rows}}
      when is_integer(cols) and is_integer(rows) ->
        state = ensure_registered_or_resize(state, cols, rows)
        {:ok, state}

      {:ok, %{"type" => "focus"}} ->
        if state.viewer_id, do: Orchestrator.viewer_focused(run_id, state.viewer_id)
        {:ok, state}

      {:ok, %{"type" => "blur"}} ->
        if state.viewer_id, do: Orchestrator.viewer_blurred(run_id, state.viewer_id)
        {:ok, state}

      _ ->
        {:ok, state}
    end
  end

  # Binary frames: forward to stdin. Synthesize focus implicitly because
  # typing into the terminal implies the user wants to drive it.
  def handle_in({data, [opcode: :binary]}, %{run_id: run_id} = state) do
    if state.viewer_id && not state.is_focused do
      Orchestrator.viewer_focused(run_id, state.viewer_id)
    end
    Orchestrator.write_stdin(run_id, data)
    {:ok, state}
  end

  # ----- events from RunServer -----

  @impl true
  def handle_info({:bytes, chunk}, state), do: {:push, {:binary, chunk}, state}

  def handle_info({:snapshot, frame}, state) do
    {:push, {:text, Jason.encode!(frame)}, state}
  end

  def handle_info({:state, frame}, state) do
    {:push, {:text, Jason.encode!(frame)}, state}
  end

  # focus_state needs per-viewer rewrite: server broadcasts the focused
  # viewer's id; each connection translates that into a {focused, by_self}
  # pair and tracks its own is_focused flag for the implicit-stdin-focus rule.
  def handle_info({:event, %{type: "focus_state", focused_viewer: focused_id}}, state) do
    by_self = state.viewer_id != nil and state.viewer_id == focused_id
    is_focused = focused_id != nil and by_self
    state = %{state | is_focused: is_focused}
    frame = Jason.encode!(%{type: "focus_state", focused: focused_id != nil, by_self: by_self})
    {:push, {:text, frame}, state}
  end

  def handle_info({:event, frame}, state) do
    {:push, {:text, Jason.encode!(frame)}, state}
  end

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{run_id: run_id, viewer_id: viewer_id}) when not is_nil(viewer_id) do
    Orchestrator.viewer_left(run_id, viewer_id)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  # ----- helpers -----

  # On first hello, register with RunServer (which assigns a viewer_id).
  # On subsequent hellos / resizes, just update the dims via viewer_resized.
  defp ensure_registered_or_resize(%{viewer_id: nil} = state, cols, rows) do
    case Orchestrator.viewer_joined(state.run_id, self(), cols, rows) do
      {:ok, vid} -> %{state | viewer_id: vid}
      _ -> state
    end
  end

  defp ensure_registered_or_resize(%{viewer_id: vid} = state, cols, rows) do
    Orchestrator.viewer_resized(state.run_id, vid, cols, rows)
    state
  end
end
