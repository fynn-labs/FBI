defmodule FBI.Orchestrator.NudgeWorker do
  @moduledoc """
  Tiny GenServer that handles deferred limit-nudge actions without blocking
  the LimitMonitor. Receives `{:second_ctrlc, socket}` and `{:stop_container, container_id}`
  via `Process.send_after/3` and executes them on its own timer.
  """

  use GenServer

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, opts)
  end

  @spec schedule_second_ctrlc(GenServer.server(), port() | :inet.socket(), non_neg_integer()) ::
          :ok
  def schedule_second_ctrlc(server, socket, after_ms) do
    GenServer.cast(server, {:schedule_second_ctrlc, socket, after_ms})
  end

  @spec schedule_stop_container(GenServer.server(), String.t(), non_neg_integer()) :: :ok
  def schedule_stop_container(server, container_id, after_ms) do
    GenServer.cast(server, {:schedule_stop_container, container_id, after_ms})
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_cast({:schedule_second_ctrlc, socket, after_ms}, state) do
    Process.send_after(self(), {:second_ctrlc, socket}, after_ms)
    {:noreply, state}
  end

  def handle_cast({:schedule_stop_container, container_id, after_ms}, state) do
    Process.send_after(self(), {:stop_container, container_id}, after_ms)
    {:noreply, state}
  end

  @impl true
  def handle_info({:second_ctrlc, socket}, state) do
    _ = :gen_tcp.send(socket, <<3>>)
    {:noreply, state}
  end

  def handle_info({:stop_container, container_id}, state) do
    FBI.Docker.stop_container(container_id, t: 5)
    {:noreply, state}
  end
end
