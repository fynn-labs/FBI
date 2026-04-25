defmodule FBIWeb.Sockets.ProxyWSHandlerTest do
  use ExUnit.Case, async: true

  test "module exposes a WebSock implementation" do
    Code.ensure_loaded(FBIWeb.Sockets.ProxyWSHandler)
    assert function_exported?(FBIWeb.Sockets.ProxyWSHandler, :init, 1)
    assert function_exported?(FBIWeb.Sockets.ProxyWSHandler, :handle_in, 2)
    assert function_exported?(FBIWeb.Sockets.ProxyWSHandler, :handle_info, 2)
    assert function_exported?(FBIWeb.Sockets.ProxyWSHandler, :terminate, 2)
  end
end
