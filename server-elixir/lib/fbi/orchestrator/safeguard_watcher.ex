defmodule FBI.Orchestrator.SafeguardWatcher do
  @moduledoc "Port of src/server/orchestrator/safeguardWatcher.ts."
  use GenServer

  alias FBI.Orchestrator.SafeguardRepo

  defstruct [:bare_dir, :branch, :on_snapshot, :last_sha, :fs_pid]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def stop(pid), do: GenServer.stop(pid)

  @impl true
  def init(opts) do
    state = %__MODULE__{
      bare_dir: Keyword.fetch!(opts, :bare_dir),
      branch: Keyword.fetch!(opts, :branch),
      on_snapshot: Keyword.fetch!(opts, :on_snapshot),
      last_sha: nil,
      fs_pid: nil
    }

    {:ok, fs_pid} = FileSystem.start_link(dirs: [state.bare_dir])

    FileSystem.subscribe(fs_pid)

    state = %{state | fs_pid: fs_pid}
    state = emit(state)
    {:ok, state}
  end

  @impl true
  def handle_info({:file_event, _pid, {_path, _events}}, state) do
    state = emit(state)
    {:noreply, state}
  end

  @impl true
  def handle_info({:file_event, _pid, :stop}, state) do
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    if state.fs_pid, do: GenServer.stop(state.fs_pid, :normal)
    :ok
  end

  defp emit(state) do
    head = SafeguardRepo.head(state.bare_dir, state.branch)
    sha = if head, do: head.sha, else: nil

    if sha != state.last_sha do
      head_files = SafeguardRepo.head_files(state.bare_dir, state.branch)

      payload = %{
        dirty: [],
        head: head,
        head_files: head_files,
        branch_base: nil,
        live: false,
        dirty_submodules: []
      }

      state.on_snapshot.(payload)
      %{state | last_sha: sha}
    else
      state
    end
  end
end
