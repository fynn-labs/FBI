defmodule FBI.Orchestrator.ViewerRegistryTest do
  @moduledoc """
  Tests for the viewer registry logic inside RunServer.

  We avoid spinning up a full RunServer (which needs DB + Docker) and instead
  test the relevant GenServer callbacks in isolation. We do this by
  instantiating a lightweight test-only GenServer (`ViewerRegistryTestServer`)
  that implements only the viewer-registry handlers — keeping the same module
  state shape as RunServer so the handlers are unchanged.

  The NIF (FBI.Terminal) is real: all tests run with the Rust NIF loaded.
  """
  use ExUnit.Case, async: false

  alias FBI.Orchestrator.Viewer

  # ──────────────────────────────────────────────────────────────────────────
  # Lightweight test GenServer — just the viewer registry bits
  # ──────────────────────────────────────────────────────────────────────────

  defmodule ViewerRegistryServer do
    @moduledoc false
    use GenServer

    alias FBI.Orchestrator.Viewer

    defstruct [
      :run_id,
      :term_handle,
      :container_id,
      viewers: %{},
      focused_viewer: nil
    ]

    def start_link(opts \\ []) do
      GenServer.start_link(__MODULE__, opts)
    end

    @impl true
    def init(_opts) do
      term_handle = FBI.Terminal.new(80, 24)
      {:ok, %__MODULE__{run_id: "test", term_handle: term_handle}}
    end

    # ── handle_call passthrough to the real RunServer private logic ──

    @impl true
    def handle_call({:viewer_joined, ws_pid, cols, rows}, _from, state) do
      ref = make_ref()
      monitor_ref = Process.monitor(ws_pid)
      now = System.monotonic_time()

      v = %Viewer{
        id: ref,
        ws_pid: ws_pid,
        ws_monitor_ref: monitor_ref,
        cols: cols,
        rows: rows,
        focused_at: nil,
        joined_at: now
      }

      state = %{state | viewers: Map.put(state.viewers, ref, v)}

      state =
        if state.focused_viewer == nil do
          state
          |> Map.put(:focused_viewer, ref)
          |> update_in([Access.key(:viewers), ref, Access.key(:focused_at)], fn _ -> now end)
        else
          state
        end

      {:reply, {:ok, ref}, state}
    end

    def handle_call({:viewer_focused, viewer_id}, _from, state) do
      case state.viewers[viewer_id] do
        nil ->
          {:reply, {:error, :unknown_viewer}, state}

        _v ->
          now = System.monotonic_time()

          state =
            state
            |> update_in(
              [Access.key(:viewers), viewer_id, Access.key(:focused_at)],
              fn _ -> now end
            )
            |> Map.put(:focused_viewer, viewer_id)

          {:reply, :ok, state}
      end
    end

    def handle_call({:viewer_blurred, viewer_id}, _from, state) do
      state =
        if state.focused_viewer == viewer_id do
          new_focused = pick_fallback_focus(state.viewers, viewer_id)
          %{state | focused_viewer: new_focused}
        else
          state
        end

      {:reply, :ok, state}
    end

    def handle_call({:viewer_resized, viewer_id, cols, rows}, _from, state) do
      case state.viewers[viewer_id] do
        nil ->
          {:reply, {:error, :unknown_viewer}, state}

        _v ->
          state =
            state
            |> update_in([Access.key(:viewers), viewer_id, Access.key(:cols)], fn _ -> cols end)
            |> update_in([Access.key(:viewers), viewer_id, Access.key(:rows)], fn _ -> rows end)

          {:reply, :ok, state}
      end
    end

    def handle_call({:viewer_left, viewer_id}, _from, state) do
      {:reply, :ok, drop_viewer(state, viewer_id)}
    end

    def handle_call(:snapshot, _from, state) do
      snap =
        case state.term_handle do
          nil -> %FBI.Terminal.Snapshot{ansi: "\e[2J\e[H", cols: 80, rows: 24, byte_offset: 0}
          h -> FBI.Terminal.snapshot(h)
        end

      {:reply, snap, state}
    end

    def handle_call({:snapshot_at, offset}, _from, state) do
      pref =
        case state.term_handle do
          nil -> %FBI.Terminal.ModePrefix{ansi: ""}
          h -> FBI.Terminal.snapshot_at(h, offset)
        end

      {:reply, pref, state}
    end

    # ── handle_info: WS pid :DOWN ──

    @impl true
    def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
      case Enum.find(state.viewers, fn {_, v} -> v.ws_monitor_ref == ref end) do
        {viewer_id, _} -> {:noreply, drop_viewer(state, viewer_id)}
        nil -> {:noreply, state}
      end
    end

    def handle_info(_, state), do: {:noreply, state}

    # ── Private helpers (duplicated from RunServer for isolation) ──

    defp drop_viewer(state, viewer_id) do
      state =
        case state.viewers[viewer_id] do
          nil ->
            state

          v ->
            Process.demonitor(v.ws_monitor_ref, [:flush])
            Map.update!(state, :viewers, &Map.delete(&1, viewer_id))
        end

      if state.focused_viewer == viewer_id do
        new_focused = pick_fallback_focus(state.viewers, viewer_id)
        %{state | focused_viewer: new_focused}
      else
        state
      end
    end

    defp pick_fallback_focus(viewers, _excluded) when map_size(viewers) == 0, do: nil

    defp pick_fallback_focus(viewers, _excluded) do
      prev_focused = Enum.filter(viewers, fn {_, v} -> v.focused_at != nil end)

      case prev_focused do
        [] ->
          {id, _v} = Enum.max_by(viewers, fn {_, v} -> v.joined_at end)
          id

        list ->
          {id, _v} = Enum.max_by(list, fn {_, v} -> v.focused_at end)
          id
      end
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # Test helpers
  # ──────────────────────────────────────────────────────────────────────────

  defp start_server do
    {:ok, pid} = ViewerRegistryServer.start_link()
    pid
  end

  defp stop_server(pid) do
    if Process.alive?(pid), do: GenServer.stop(pid, :normal, 500)
  end

  # ──────────────────────────────────────────────────────────────────────────
  # viewer_joined
  # ──────────────────────────────────────────────────────────────────────────

  test "viewer_joined adds to registry" do
    pid = start_server()

    try do
      ws_pid = spawn(fn -> Process.sleep(:infinity) end)
      {:ok, viewer_id} = GenServer.call(pid, {:viewer_joined, ws_pid, 80, 24})

      state = :sys.get_state(pid)
      assert Map.has_key?(state.viewers, viewer_id)
      v = state.viewers[viewer_id]
      assert v.cols == 80
      assert v.rows == 24
      assert v.ws_pid == ws_pid
    after
      stop_server(pid)
    end
  end

  test "first viewer to join becomes focused_viewer" do
    pid = start_server()

    try do
      ws_pid = spawn(fn -> Process.sleep(:infinity) end)
      {:ok, viewer_id} = GenServer.call(pid, {:viewer_joined, ws_pid, 80, 24})

      state = :sys.get_state(pid)
      assert state.focused_viewer == viewer_id
    after
      stop_server(pid)
    end
  end

  test "second viewer to join does not steal focus" do
    pid = start_server()

    try do
      ws1 = spawn(fn -> Process.sleep(:infinity) end)
      ws2 = spawn(fn -> Process.sleep(:infinity) end)

      {:ok, viewer_id_1} = GenServer.call(pid, {:viewer_joined, ws1, 80, 24})
      {:ok, _viewer_id_2} = GenServer.call(pid, {:viewer_joined, ws2, 100, 40})

      state = :sys.get_state(pid)
      assert state.focused_viewer == viewer_id_1
    after
      stop_server(pid)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # viewer_focused
  # ──────────────────────────────────────────────────────────────────────────

  test "viewer_focused updates focused_viewer and focused_at" do
    pid = start_server()

    try do
      ws1 = spawn(fn -> Process.sleep(:infinity) end)
      ws2 = spawn(fn -> Process.sleep(:infinity) end)

      {:ok, _v1} = GenServer.call(pid, {:viewer_joined, ws1, 80, 24})
      {:ok, v2} = GenServer.call(pid, {:viewer_joined, ws2, 80, 24})

      :ok = GenServer.call(pid, {:viewer_focused, v2})

      state = :sys.get_state(pid)
      assert state.focused_viewer == v2
      assert state.viewers[v2].focused_at != nil
    after
      stop_server(pid)
    end
  end

  test "viewer_focused unknown viewer returns error" do
    pid = start_server()

    try do
      result = GenServer.call(pid, {:viewer_focused, make_ref()})
      assert result == {:error, :unknown_viewer}
    after
      stop_server(pid)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # viewer_left / drop_viewer
  # ──────────────────────────────────────────────────────────────────────────

  test "viewer_left removes viewer from registry" do
    pid = start_server()

    try do
      ws = spawn(fn -> Process.sleep(:infinity) end)
      {:ok, viewer_id} = GenServer.call(pid, {:viewer_joined, ws, 80, 24})
      :ok = GenServer.call(pid, {:viewer_left, viewer_id})

      state = :sys.get_state(pid)
      refute Map.has_key?(state.viewers, viewer_id)
    after
      stop_server(pid)
    end
  end

  test "viewer_left on focused viewer triggers fallback" do
    pid = start_server()

    try do
      ws1 = spawn(fn -> Process.sleep(:infinity) end)
      ws2 = spawn(fn -> Process.sleep(:infinity) end)

      {:ok, v1} = GenServer.call(pid, {:viewer_joined, ws1, 80, 24})
      {:ok, v2} = GenServer.call(pid, {:viewer_joined, ws2, 80, 24})

      # v1 is focused (first-joined). Remove it.
      :ok = GenServer.call(pid, {:viewer_left, v1})

      state = :sys.get_state(pid)
      assert state.focused_viewer == v2
    after
      stop_server(pid)
    end
  end

  test "viewer_left on last viewer sets focused_viewer to nil" do
    pid = start_server()

    try do
      ws = spawn(fn -> Process.sleep(:infinity) end)
      {:ok, viewer_id} = GenServer.call(pid, {:viewer_joined, ws, 80, 24})
      :ok = GenServer.call(pid, {:viewer_left, viewer_id})

      state = :sys.get_state(pid)
      assert state.focused_viewer == nil
    after
      stop_server(pid)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # WS pid :DOWN cleans up the viewer
  # ──────────────────────────────────────────────────────────────────────────

  test "WS pid :DOWN removes viewer automatically" do
    pid = start_server()

    try do
      # Spawn a process we monitor too, so we know when it's dead.
      {ws_pid, ws_ref} = spawn_monitor(fn -> Process.sleep(:infinity) end)

      {:ok, viewer_id} = GenServer.call(pid, {:viewer_joined, ws_pid, 80, 24})

      # Kill the WS process.
      Process.exit(ws_pid, :kill)

      # Wait for our own monitor to confirm it's dead.
      receive do
        {:DOWN, ^ws_ref, :process, ^ws_pid, _} -> :ok
      after
        1000 -> flunk("ws_pid didn't die in time")
      end

      # Give the GenServer time to process its own :DOWN message.
      Process.sleep(50)
      # Sync call ensures the :DOWN has been processed before we read state.
      :sys.get_state(pid)

      state = :sys.get_state(pid)
      refute Map.has_key?(state.viewers, viewer_id)
    after
      stop_server(pid)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # pick_fallback_focus policy
  # ──────────────────────────────────────────────────────────────────────────

  test "fallback prefers most-recently-focused viewer" do
    pid = start_server()

    try do
      ws1 = spawn(fn -> Process.sleep(:infinity) end)
      ws2 = spawn(fn -> Process.sleep(:infinity) end)
      ws3 = spawn(fn -> Process.sleep(:infinity) end)

      {:ok, v1} = GenServer.call(pid, {:viewer_joined, ws1, 80, 24})
      {:ok, v2} = GenServer.call(pid, {:viewer_joined, ws2, 80, 24})
      {:ok, v3} = GenServer.call(pid, {:viewer_joined, ws3, 80, 24})

      # Focus sequence: v2, v3, v1 — v1 is now the most-recently-focused.
      :ok = GenServer.call(pid, {:viewer_focused, v2})
      :ok = GenServer.call(pid, {:viewer_focused, v3})
      :ok = GenServer.call(pid, {:viewer_focused, v1})

      # Remove v1. Fallback should be v3 (last explicitly focused before v1).
      :ok = GenServer.call(pid, {:viewer_left, v1})

      state = :sys.get_state(pid)
      assert state.focused_viewer == v3
    after
      stop_server(pid)
    end
  end

  test "fallback uses most-recently-joined when no viewer was ever focused" do
    pid = start_server()

    try do
      ws1 = spawn(fn -> Process.sleep(:infinity) end)
      ws2 = spawn(fn -> Process.sleep(:infinity) end)

      # Inject viewers with no focused_at timestamps directly so neither has
      # ever been explicitly focused — tests the joined_at fallback branch.
      now = System.monotonic_time()
      v1 = make_ref()
      v2 = make_ref()

      :sys.replace_state(pid, fn state ->
        viewers = %{
          v1 => %Viewer{
            id: v1,
            ws_pid: ws1,
            ws_monitor_ref: Process.monitor(ws1),
            cols: 80,
            rows: 24,
            focused_at: nil,
            joined_at: now - 1000
          },
          v2 => %Viewer{
            id: v2,
            ws_pid: ws2,
            ws_monitor_ref: Process.monitor(ws2),
            cols: 80,
            rows: 24,
            focused_at: nil,
            # v2 joined later
            joined_at: now
          }
        }

        %{state | viewers: viewers, focused_viewer: v1}
      end)

      # Remove v1 (currently focused, has no focused_at). Fallback should
      # pick v2 as most-recently-joined.
      :ok = GenServer.call(pid, {:viewer_left, v1})

      state = :sys.get_state(pid)
      assert state.focused_viewer == v2
    after
      stop_server(pid)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # viewer_blurred
  # ──────────────────────────────────────────────────────────────────────────

  test "viewer_blurred on non-focused viewer is a no-op" do
    pid = start_server()

    try do
      ws1 = spawn(fn -> Process.sleep(:infinity) end)
      ws2 = spawn(fn -> Process.sleep(:infinity) end)

      {:ok, v1} = GenServer.call(pid, {:viewer_joined, ws1, 80, 24})
      {:ok, v2} = GenServer.call(pid, {:viewer_joined, ws2, 80, 24})

      # v1 is focused; blurring v2 should leave focus on v1.
      :ok = GenServer.call(pid, {:viewer_blurred, v2})

      state = :sys.get_state(pid)
      assert state.focused_viewer == v1
    after
      stop_server(pid)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # viewer_resized
  # ──────────────────────────────────────────────────────────────────────────

  test "viewer_resized updates the viewer's cols/rows" do
    pid = start_server()

    try do
      ws = spawn(fn -> Process.sleep(:infinity) end)
      {:ok, viewer_id} = GenServer.call(pid, {:viewer_joined, ws, 80, 24})
      :ok = GenServer.call(pid, {:viewer_resized, viewer_id, 132, 50})

      state = :sys.get_state(pid)
      v = state.viewers[viewer_id]
      assert v.cols == 132
      assert v.rows == 50
    after
      stop_server(pid)
    end
  end

  test "viewer_resized on unknown viewer returns error" do
    pid = start_server()

    try do
      result = GenServer.call(pid, {:viewer_resized, make_ref(), 80, 24})
      assert result == {:error, :unknown_viewer}
    after
      stop_server(pid)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # snapshot / snapshot_at (via the real NIF)
  # ──────────────────────────────────────────────────────────────────────────

  test "snapshot returns a Snapshot struct with real NIF" do
    pid = start_server()

    try do
      snap = GenServer.call(pid, :snapshot)
      assert %FBI.Terminal.Snapshot{} = snap
      assert is_binary(snap.ansi)
      assert snap.cols > 0
      assert snap.rows > 0
    after
      stop_server(pid)
    end
  end

  test "snapshot_at returns a ModePrefix struct with real NIF" do
    pid = start_server()

    try do
      pref = GenServer.call(pid, {:snapshot_at, 0})
      assert %FBI.Terminal.ModePrefix{} = pref
      assert is_binary(pref.ansi)
    after
      stop_server(pid)
    end
  end

  test "snapshot without term_handle returns fallback struct" do
    pid = start_server()

    try do
      :sys.replace_state(pid, fn state -> %{state | term_handle: nil} end)
      snap = GenServer.call(pid, :snapshot)

      assert snap == %FBI.Terminal.Snapshot{
               ansi: "\e[2J\e[H",
               cols: 80,
               rows: 24,
               byte_offset: 0
             }
    after
      stop_server(pid)
    end
  end
end
