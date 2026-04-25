defmodule FBIWeb.Sockets.StatesWSHandler do
  @moduledoc "WebSock handler for /api/ws/states — global run state broadcast."

  @behaviour WebSock

  @impl true
  def init(_state) do
    Phoenix.PubSub.subscribe(FBI.PubSub, "global_states")
    {:ok, %{}}
  end

  @impl true
  def handle_in(_frame, state), do: {:ok, state}

  @impl true
  def handle_info({:state, map}, state) do
    {:push, {:text, Jason.encode!(map)}, state}
  end

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, _state), do: :ok
end
