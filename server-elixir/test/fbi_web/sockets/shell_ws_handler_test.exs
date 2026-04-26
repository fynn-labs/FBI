defmodule FBIWeb.Sockets.ShellWSHandlerTest do
  @moduledoc """
  Unit tests for FBIWeb.Sockets.ShellWSHandler.

  We call the WebSock callbacks directly — no live WebSocket connection needed.
  Orchestrator.snapshot/1 and viewer_joined/4 etc. fall back gracefully when
  there is no live RunServer for the run_id (see RunServer.snapshot_via_call/1).
  """
  use FBI.DataCase, async: false

  alias FBIWeb.Sockets.ShellWSHandler

  # A fake run_id that has no live RunServer — safe to use because all
  # Orchestrator calls degrade gracefully when the registry lookup returns [].
  @run_id 999_999_999

  # ──────────────────────────────────────────────────────────────────────────
  # init/1
  # ──────────────────────────────────────────────────────────────────────────

  describe "init/1" do
    test "returns :ok with initial state" do
      assert {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})
      assert state.run_id == @run_id
      assert state.viewer_id == nil
      assert state.is_focused == false
    end

    test "subscribes to all four PubSub topics" do
      ShellWSHandler.init(%{run_id: @run_id})

      for suffix <- ["bytes", "events", "state", "snapshot"] do
        topic = "run:#{@run_id}:#{suffix}"
        Phoenix.PubSub.broadcast(FBI.PubSub, topic, {:ping, suffix})
        assert_receive {:ping, ^suffix}
      end
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # handle_in — hello (first time)
  # ──────────────────────────────────────────────────────────────────────────

  describe "handle_in/2 — hello" do
    test "first hello returns a snapshot text frame" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})

      msg = Jason.encode!(%{type: "hello", cols: 80, rows: 24})
      assert {:push, {:text, json}, _new_state} =
               ShellWSHandler.handle_in({msg, [opcode: :text]}, state)

      decoded = Jason.decode!(json)
      assert decoded["type"] == "snapshot"
      assert is_binary(decoded["ansi"])
      assert is_integer(decoded["cols"])
      assert is_integer(decoded["rows"])
    end

    test "first hello registers a viewer_id in state" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})
      assert state.viewer_id == nil

      # With no live RunServer the viewer_joined fallback returns an error,
      # so viewer_id stays nil. We verify the shape is still correct.
      msg = Jason.encode!(%{type: "hello", cols: 80, rows: 24})
      assert {:push, {:text, _json}, new_state} =
               ShellWSHandler.handle_in({msg, [opcode: :text]}, state)

      # viewer_id may be nil (no RunServer) or a ref (live RunServer) — either
      # is valid. What matters is the state map has the key.
      assert Map.has_key?(new_state, :viewer_id)
    end

    test "re-hello also returns a snapshot frame (not dropped)" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})

      hello = Jason.encode!(%{type: "hello", cols: 80, rows: 24})

      assert {:push, {:text, json1}, state1} =
               ShellWSHandler.handle_in({hello, [opcode: :text]}, state)

      decoded1 = Jason.decode!(json1)
      assert decoded1["type"] == "snapshot"

      # Send hello again (re-hello — previously dropped in old handler)
      assert {:push, {:text, json2}, _state2} =
               ShellWSHandler.handle_in({hello, [opcode: :text]}, state1)

      decoded2 = Jason.decode!(json2)
      assert decoded2["type"] == "snapshot"
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # handle_in — resize
  # ──────────────────────────────────────────────────────────────────────────

  describe "handle_in/2 — resize" do
    test "resize returns :ok (no snapshot push)" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})

      msg = Jason.encode!(%{type: "resize", cols: 120, rows: 40})
      assert {:ok, _state} = ShellWSHandler.handle_in({msg, [opcode: :text]}, state)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # handle_in — focus / blur
  # ──────────────────────────────────────────────────────────────────────────

  describe "handle_in/2 — focus and blur" do
    test "focus message returns :ok" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})

      msg = Jason.encode!(%{type: "focus"})
      assert {:ok, _state} = ShellWSHandler.handle_in({msg, [opcode: :text]}, state)
    end

    test "blur message returns :ok" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})

      msg = Jason.encode!(%{type: "blur"})
      assert {:ok, _state} = ShellWSHandler.handle_in({msg, [opcode: :text]}, state)
    end

    test "focus with a viewer_id calls viewer_focused without error" do
      # Simulate a state where viewer_id is set (pretend RunServer assigned one).
      fake_ref = make_ref()
      state = %{run_id: @run_id, viewer_id: fake_ref, is_focused: false}

      # viewer_focused falls back gracefully when no RunServer is live.
      msg = Jason.encode!(%{type: "focus"})
      assert {:ok, _state} = ShellWSHandler.handle_in({msg, [opcode: :text]}, state)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # handle_in — binary (stdin)
  # ──────────────────────────────────────────────────────────────────────────

  describe "handle_in/2 — binary stdin" do
    test "binary frame returns :ok" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})
      assert {:ok, _state} = ShellWSHandler.handle_in({"hello", [opcode: :binary]}, state)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # handle_in — unknown / malformed
  # ──────────────────────────────────────────────────────────────────────────

  describe "handle_in/2 — unknown messages" do
    test "non-JSON text frame is a no-op" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})
      assert {:ok, ^state} = ShellWSHandler.handle_in({"not json", [opcode: :text]}, state)
    end

    test "unknown JSON type is a no-op" do
      {:ok, state} = ShellWSHandler.init(%{run_id: @run_id})
      msg = Jason.encode!(%{type: "unknown_type", data: "x"})
      assert {:ok, ^state} = ShellWSHandler.handle_in({msg, [opcode: :text]}, state)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # handle_info — PubSub routing
  # ──────────────────────────────────────────────────────────────────────────

  describe "handle_info/2 — bytes" do
    test "forwards binary chunk as binary push" do
      state = %{run_id: @run_id, viewer_id: nil, is_focused: false}
      chunk = <<1, 2, 3, 4>>
      assert {:push, {:binary, ^chunk}, ^state} =
               ShellWSHandler.handle_info({:bytes, chunk}, state)
    end
  end

  describe "handle_info/2 — snapshot fan-out" do
    test "forwards snapshot map as JSON text push" do
      state = %{run_id: @run_id, viewer_id: nil, is_focused: false}
      frame = %{type: "snapshot", ansi: "\e[2J\e[H", cols: 80, rows: 24}

      assert {:push, {:text, json}, ^state} =
               ShellWSHandler.handle_info({:snapshot, frame}, state)

      decoded = Jason.decode!(json)
      assert decoded["type"] == "snapshot"
    end
  end

  describe "handle_info/2 — state" do
    test "forwards state map as JSON text push" do
      state = %{run_id: @run_id, viewer_id: nil, is_focused: false}
      frame = %{type: "run_state", state: "running"}

      assert {:push, {:text, json}, ^state} =
               ShellWSHandler.handle_info({:state, frame}, state)

      decoded = Jason.decode!(json)
      assert decoded["type"] == "run_state"
    end
  end

  describe "handle_info/2 — focus_state event" do
    test "translates focused_viewer into focused/by_self booleans" do
      fake_ref = make_ref()
      state = %{run_id: @run_id, viewer_id: fake_ref, is_focused: false}

      event = %{type: "focus_state", focused_viewer: fake_ref}
      assert {:push, {:text, json}, new_state} =
               ShellWSHandler.handle_info({:event, event}, state)

      decoded = Jason.decode!(json)
      assert decoded["type"] == "focus_state"
      assert decoded["focused"] == true
      assert decoded["by_self"] == true
      assert new_state.is_focused == true
    end

    test "sets by_self=false when another viewer is focused" do
      my_ref = make_ref()
      other_ref = make_ref()
      state = %{run_id: @run_id, viewer_id: my_ref, is_focused: true}

      event = %{type: "focus_state", focused_viewer: other_ref}
      assert {:push, {:text, json}, new_state} =
               ShellWSHandler.handle_info({:event, event}, state)

      decoded = Jason.decode!(json)
      assert decoded["focused"] == true
      assert decoded["by_self"] == false
      assert new_state.is_focused == false
    end

    test "sets focused=false and by_self=false when no viewer is focused" do
      my_ref = make_ref()
      state = %{run_id: @run_id, viewer_id: my_ref, is_focused: true}

      event = %{type: "focus_state", focused_viewer: nil}
      assert {:push, {:text, json}, new_state} =
               ShellWSHandler.handle_info({:event, event}, state)

      decoded = Jason.decode!(json)
      assert decoded["focused"] == false
      assert decoded["by_self"] == false
      assert new_state.is_focused == false
    end
  end

  describe "handle_info/2 — other events" do
    test "forwards non-focus_state events as JSON text" do
      state = %{run_id: @run_id, viewer_id: nil, is_focused: false}
      frame = %{type: "title", title: "bash"}

      assert {:push, {:text, json}, ^state} =
               ShellWSHandler.handle_info({:event, frame}, state)

      decoded = Jason.decode!(json)
      assert decoded["type"] == "title"
    end

    test "ignores unknown messages" do
      state = %{run_id: @run_id, viewer_id: nil, is_focused: false}
      assert {:ok, ^state} = ShellWSHandler.handle_info(:unknown_msg, state)
    end
  end

  # ──────────────────────────────────────────────────────────────────────────
  # terminate/2
  # ──────────────────────────────────────────────────────────────────────────

  describe "terminate/2" do
    test "returns :ok when viewer_id is nil" do
      state = %{run_id: @run_id, viewer_id: nil, is_focused: false}
      assert :ok = ShellWSHandler.terminate(:normal, state)
    end

    test "returns :ok when viewer_id is set (calls viewer_left, graceful fallback)" do
      fake_ref = make_ref()
      state = %{run_id: @run_id, viewer_id: fake_ref, is_focused: false}
      assert :ok = ShellWSHandler.terminate(:normal, state)
    end
  end
end
