defmodule FBI.Orchestrator.LimitMonitor do
  @moduledoc "Port of src/server/orchestrator/limitMonitor.ts."
  use GenServer

  @log_buffer_bytes 16 * 1024
  @idle_ms 15_000
  @warmup_ms 60_000
  @check_ms 3_000

  defstruct [
    :mount_dir,
    :on_detect,
    :log_buffer_bytes,
    :idle_ms,
    :warmup_ms,
    :check_ms,
    buf: "",
    fired: false,
    started_at: 0,
    last_activity_at: 0,
    last_total_size: 0,
    timer: nil
  ]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def stop(pid), do: GenServer.stop(pid)

  def feed_log(pid, chunk) when is_pid(pid) do
    GenServer.cast(pid, {:feed_log, chunk})
  end

  @impl true
  def init(opts) do
    now = System.monotonic_time(:millisecond)
    mount_dir = Keyword.fetch!(opts, :mount_dir)

    state = %__MODULE__{
      mount_dir: mount_dir,
      on_detect: Keyword.fetch!(opts, :on_detect),
      log_buffer_bytes: Keyword.get(opts, :log_buffer_bytes, @log_buffer_bytes),
      idle_ms: Keyword.get(opts, :idle_ms, @idle_ms),
      warmup_ms: Keyword.get(opts, :warmup_ms, @warmup_ms),
      check_ms: Keyword.get(opts, :check_ms, @check_ms),
      started_at: now,
      last_activity_at: now,
      last_total_size: mount_size(mount_dir)
    }

    timer = Process.send_after(self(), :tick, state.check_ms)
    {:ok, %{state | timer: timer}}
  end

  @impl true
  def handle_cast({:feed_log, chunk}, %{fired: false} = state) do
    stripped = FBI.Orchestrator.ResumeDetector.strip_ansi(chunk)

    if stripped == "" do
      {:noreply, state}
    else
      new_buf =
        (state.buf <> stripped) |> String.slice(-state.log_buffer_bytes, state.log_buffer_bytes)

      {:noreply, %{state | buf: new_buf}}
    end
  end

  def handle_cast({:feed_log, _}, state), do: {:noreply, state}

  @impl true
  def handle_info(:tick, %{fired: true} = state), do: {:noreply, state}

  def handle_info(:tick, state) do
    now = System.monotonic_time(:millisecond)
    size = mount_size(state.mount_dir)

    state =
      if size > state.last_total_size do
        %{state | last_activity_at: now, last_total_size: size}
      else
        state
      end

    state =
      if now - state.started_at >= state.warmup_ms and
           now - state.last_activity_at >= state.idle_ms and
           FBI.Orchestrator.ResumeDetector.contains_limit_signal(state.buf) do
        state.on_detect.()
        %{state | fired: true}
      else
        state
      end

    timer = if state.fired, do: nil, else: Process.send_after(self(), :tick, state.check_ms)
    {:noreply, %{state | timer: timer}}
  end

  defp mount_size(dir) do
    case File.ls(dir) do
      {:error, _} ->
        0

      {:ok, files} ->
        Enum.reduce(files, 0, fn f, acc ->
          case File.stat(Path.join(dir, f)) do
            {:ok, %{size: s, type: :regular}} -> acc + s
            _ -> acc
          end
        end)
    end
  end
end
