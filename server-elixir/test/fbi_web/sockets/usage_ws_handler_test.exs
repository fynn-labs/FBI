defmodule FBIWeb.Sockets.UsageWSHandlerTest do
  # DataCase is required for tests that call init/1, which delegates to
  # Poller.snapshot/0 — a function that queries the database. The sandbox
  # must be started before those calls so Ecto ownership is established.
  use FBI.DataCase, async: false

  alias FBIWeb.Sockets.UsageWSHandler

  # ---------------------------------------------------------------------------
  # init/1
  # ---------------------------------------------------------------------------

  describe "init/1" do
    test "returns :push with a JSON text frame and empty state" do
      assert {:push, {:text, json}, %{}} = UsageWSHandler.init(%{})
      decoded = Jason.decode!(json)
      assert decoded["type"] == "snapshot"
      assert is_map(decoded["state"])
    end

    test "snapshot frame includes expected top-level keys" do
      {:push, {:text, json}, %{}} = UsageWSHandler.init(%{})
      state_map = Jason.decode!(json) |> Map.fetch!("state")
      assert Map.has_key?(state_map, "plan")
      assert Map.has_key?(state_map, "observed_at")
      assert Map.has_key?(state_map, "last_error")
      assert Map.has_key?(state_map, "last_error_at")
      assert Map.has_key?(state_map, "buckets")
      assert Map.has_key?(state_map, "pacing")
    end

    test "init subscribes the calling process to the usage topic" do
      assert {:push, {:text, _}, %{}} = UsageWSHandler.init(%{})
      Phoenix.PubSub.broadcast(FBI.PubSub, "usage", %{type: "snapshot", state: %{plan: "max"}})
      assert_receive %{type: "snapshot", state: %{plan: "max"}}
    end
  end

  # ---------------------------------------------------------------------------
  # handle_in/2
  # ---------------------------------------------------------------------------

  describe "handle_in/2" do
    test "is a no-op for any text frame" do
      state = %{some: "state"}
      assert {:ok, ^state} = UsageWSHandler.handle_in({:text, "hello"}, state)
    end

    test "is a no-op for a binary frame" do
      state = %{}
      assert {:ok, ^state} = UsageWSHandler.handle_in({:binary, <<1, 2, 3>>}, state)
    end
  end

  # ---------------------------------------------------------------------------
  # handle_info/2 — snapshot message
  # ---------------------------------------------------------------------------

  describe "handle_info/2 with snapshot message" do
    test "pushes a JSON text frame with type snapshot" do
      msg = %{type: "snapshot", state: %{plan: "pro", buckets: []}}
      state = %{}

      assert {:push, {:text, json}, ^state} = UsageWSHandler.handle_info(msg, state)
      decoded = Jason.decode!(json)
      assert decoded["type"] == "snapshot"
      assert is_map(decoded["state"])
    end

    test "preserves the caller's state unchanged" do
      msg = %{type: "snapshot", state: %{plan: nil}}
      state = %{conn_id: 42}

      assert {:push, {:text, _}, ^state} = UsageWSHandler.handle_info(msg, state)
    end
  end

  # ---------------------------------------------------------------------------
  # handle_info/2 — threshold_crossed message
  # ---------------------------------------------------------------------------

  describe "handle_info/2 with threshold_crossed message" do
    test "pushes JSON-encoded threshold_crossed frame" do
      msg = %{type: "threshold_crossed", bucket_id: "5min", threshold: 75, reset_at: nil}
      state = %{}

      assert {:push, {:text, json}, ^state} = UsageWSHandler.handle_info(msg, state)
      decoded = Jason.decode!(json)
      assert decoded["type"] == "threshold_crossed"
      assert decoded["bucket_id"] == "5min"
      assert decoded["threshold"] == 75
      assert is_nil(decoded["reset_at"])
    end

    test "encodes reset_at integer when present" do
      msg = %{
        type: "threshold_crossed",
        bucket_id: "1hour",
        threshold: 90,
        reset_at: 1_700_000_000
      }

      state = %{}

      assert {:push, {:text, json}, ^state} = UsageWSHandler.handle_info(msg, state)
      decoded = Jason.decode!(json)
      assert decoded["reset_at"] == 1_700_000_000
    end
  end

  # ---------------------------------------------------------------------------
  # handle_info/2 — unrecognized messages
  # ---------------------------------------------------------------------------

  describe "handle_info/2 with unrecognized messages" do
    test "is a no-op for an atom message" do
      state = %{}
      assert {:ok, ^state} = UsageWSHandler.handle_info(:some_atom, state)
    end

    test "is a no-op for a map without a :type key" do
      state = %{}
      assert {:ok, ^state} = UsageWSHandler.handle_info(%{bucket_id: "x"}, state)
    end

    test "is a no-op for a plain string" do
      state = %{x: 1}
      assert {:ok, ^state} = UsageWSHandler.handle_info("unexpected", state)
    end
  end

  # ---------------------------------------------------------------------------
  # terminate/2
  # ---------------------------------------------------------------------------

  describe "terminate/2" do
    test "returns :ok for any reason" do
      assert :ok = UsageWSHandler.terminate(:normal, %{})
      assert :ok = UsageWSHandler.terminate({:error, :closed}, %{})
    end
  end
end
