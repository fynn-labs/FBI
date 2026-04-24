defmodule FBI.Housekeeping.DraftUploadsGc do
  @moduledoc """
  Sweeps aged draft-upload directories hourly. Age threshold: 24 hours.
  On first start, also cleans orphan `.part` files in run uploads subtrees.

  GenServer: runs the sweep on an interval, holds only a `:refs` tuple.
  """

  use GenServer
  require Logger

  @default_interval_ms 60 * 60 * 1000
  @ttl_ms 24 * 60 * 60 * 1000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    draft_dir = Application.get_env(:fbi, :draft_uploads_dir)
    runs_dir = Application.get_env(:fbi, :runs_dir)

    if draft_dir do
      sweep_draft_uploads(draft_dir)
      if runs_dir, do: sweep_part_files(runs_dir)
    end

    ref = if draft_dir, do: schedule_next(interval), else: nil
    {:ok, %{ref: ref, interval: interval, draft_dir: draft_dir, runs_dir: runs_dir}}
  end

  @impl true
  def handle_info(:sweep, state) do
    if state.draft_dir, do: sweep_draft_uploads(state.draft_dir)
    {:noreply, %{state | ref: schedule_next(state.interval)}}
  end

  defp schedule_next(ms), do: Process.send_after(self(), :sweep, ms)

  @doc false
  def sweep_draft_uploads(draft_dir) do
    now = System.system_time(:millisecond)

    case File.ls(draft_dir) do
      {:ok, entries} ->
        Enum.each(entries, fn name ->
          path = Path.join(draft_dir, name)

          case File.stat(path, time: :posix) do
            {:ok, %File.Stat{type: :directory, mtime: mt}} ->
              mtime_ms = mt * 1000

              if now - mtime_ms >= @ttl_ms do
                File.rm_rf(path)
              end

            _ ->
              :ok
          end
        end)

      {:error, _} ->
        :ok
    end
  end

  @doc false
  def sweep_part_files(runs_dir) do
    case File.ls(runs_dir) do
      {:ok, entries} ->
        Enum.each(entries, fn name ->
          uploads = Path.join([runs_dir, name, "uploads"])

          case File.ls(uploads) do
            {:ok, files} ->
              Enum.each(files, fn f ->
                if String.ends_with?(f, ".part"), do: File.rm(Path.join(uploads, f))
              end)

            _ ->
              :ok
          end
        end)

      _ ->
        :ok
    end
  end
end
