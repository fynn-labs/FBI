defmodule FBIWeb.UsageSocketControllerTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded(FBIWeb.UsageSocketController)
    Code.ensure_loaded(FBIWeb.Sockets.UsageWSHandler)
    :ok
  end

  # Regression: previously the route pointed at the WebSock handler module
  # directly. Phoenix's dispatcher calls `Module.init(:action)`, which hit the
  # WebSock `init/1` callback (returning a `{:push, ...}` tuple) and then tried
  # `Module.call(conn, that_tuple)` — undefined. Having a dedicated controller
  # module isolates the Phoenix dispatch path from the WebSock callbacks.
  test "controller is a phoenix controller, not a WebSock callback module" do
    # A Phoenix controller exports `action/2` (via `use FBIWeb, :controller`).
    # A WebSock handler exports `handle_in/2`, `handle_info/2`, `terminate/2`.
    # The two must not be in the same module.
    assert function_exported?(FBIWeb.UsageSocketController, :action, 2)
    refute function_exported?(FBIWeb.UsageSocketController, :handle_in, 2)
    refute function_exported?(FBIWeb.UsageSocketController, :handle_info, 2)

    assert function_exported?(FBIWeb.Sockets.UsageWSHandler, :handle_in, 2)
    refute function_exported?(FBIWeb.Sockets.UsageWSHandler, :action, 2)
  end

  test "upgrade/2 is defined on the controller" do
    assert function_exported?(FBIWeb.UsageSocketController, :upgrade, 2)
  end
end
