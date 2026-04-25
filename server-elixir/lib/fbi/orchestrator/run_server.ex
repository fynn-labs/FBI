defmodule FBI.Orchestrator.RunServer do
  @moduledoc """
  Per-run lifecycle GenServer. Registered in FBI.Orchestrator.Registry by run_id.

  Lifecycle flows (launch / resume / continue / reattach) run in a Task.async so
  the GenServer stays responsive to write_stdin / resize / cancel calls during
  the long Docker wait.

  PubSub topics used:
    "run:{id}:bytes"  — raw terminal bytes (binary frames)
    "run:{id}:events" — JSON event maps (usage, title, changes)
    "run:{id}:state"  — run state frames (maps)
    "global_states"   — global run state maps
  """

  use GenServer
  require Logger

  alias FBI.Runs.{Queries, LogStore}

  alias FBI.Orchestrator.{
    ScreenState,
    ResumeDetector,
    ResultParser,
    TitleWatcher,
    UsageTailer,
    LimitMonitor,
    RuntimeStateWatcher,
    SafeguardWatcher,
    MirrorStatusPoller,
    ResumeScheduler,
    SessionId,
    ClaudeJson
  }

  @type mode :: :launch | :resume | :continue | :reattach

  defstruct [
    :run_id,
    :mode,
    :config,
    :lifecycle_task_ref,
    :attach_socket,
    :container_id,
    last_rate_limit: nil,
    cancelled: false
  ]

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link({run_id, mode, config}) do
    GenServer.start_link(
      __MODULE__,
      {run_id, mode, config},
      name: via(run_id)
    )
  end

  def via(run_id), do: {:via, Registry, {FBI.Orchestrator.Registry, run_id}}

  def write_stdin(run_id, bytes) do
    case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
      [{pid, _}] -> GenServer.cast(pid, {:write_stdin, bytes})
      [] -> :noop
    end
  end

  def resize(run_id, cols, rows) do
    case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
      [{pid, _}] -> GenServer.cast(pid, {:resize, cols, rows})
      [] -> :ok
    end
  end

  def cancel(run_id) do
    case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
      [{pid, _}] -> GenServer.call(pid, :cancel, 10_000)
      [] -> :ok
    end
  end

  def set_container(pid, container_id, attach_socket) do
    GenServer.call(pid, {:set_container, container_id, attach_socket})
  end

  def set_last_rate_limit(pid, snapshot) do
    GenServer.cast(pid, {:set_rate_limit, snapshot})
  end

  def get_last_rate_limit(run_id) do
    case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
      [{pid, _}] -> GenServer.call(pid, :get_rate_limit, 5_000)
      [] -> nil
    end
  end

  def mark_cancelled(run_id) do
    case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
      [{pid, _}] -> GenServer.call(pid, :mark_cancelled, 5_000)
      [] -> false
    end
  end

  def publish_state(run_id) do
    case Queries.get(run_id) do
      {:ok, run} ->
        frame = %{
          type: "state",
          state: run.state,
          state_entered_at: run.state_entered_at,
          next_resume_at: run.next_resume_at,
          resume_attempts: run.resume_attempts,
          last_limit_reset_at: run.last_limit_reset_at
        }

        Phoenix.PubSub.broadcast(FBI.PubSub, "run:#{run_id}:state", {:state, frame})

        Phoenix.PubSub.broadcast(
          FBI.PubSub,
          "global_states",
          {:state, Map.merge(frame, %{run_id: run_id, project_id: run.project_id})}
        )

      _ ->
        :ok
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init({run_id, mode, config}) do
    state = %__MODULE__{run_id: run_id, mode: mode, config: config}
    {:ok, state, {:continue, mode}}
  end

  @impl true
  def handle_continue(mode, state) when mode in [:launch, :resume, :continue, :reattach] do
    parent = self()

    task =
      Task.async(fn ->
        try do
          run_lifecycle(mode, state.run_id, state.config, parent)
        catch
          kind, reason ->
            Logger.error("RunServer lifecycle crashed: #{kind} #{inspect(reason)}")
            {:lifecycle_error, kind, reason}
        end
      end)

    {:noreply, %{state | lifecycle_task_ref: task.ref}}
  end

  @impl true
  def handle_cast({:write_stdin, bytes}, %{attach_socket: socket} = state) when socket != nil do
    :gen_tcp.send(socket, bytes)
    {:noreply, state}
  end

  def handle_cast({:write_stdin, _}, state), do: {:noreply, state}

  def handle_cast({:resize, cols, rows}, %{container_id: cid} = state) when cid != nil do
    FBI.Docker.resize_container(cid, cols, rows)
    ScreenState.resize(state.run_id, cols, rows)
    {:noreply, state}
  end

  def handle_cast({:resize, _, _}, state), do: {:noreply, state}

  def handle_cast({:set_rate_limit, snapshot}, state) do
    {:noreply, %{state | last_rate_limit: snapshot}}
  end

  @impl true
  def handle_call({:set_container, cid, socket}, _from, state) do
    {:reply, :ok, %{state | container_id: cid, attach_socket: socket}}
  end

  def handle_call(:cancel, _from, %{container_id: cid} = state) when cid != nil do
    Queries.mark_finished(state.run_id, %{state: "cancelled", error: nil})
    publish_state(state.run_id)
    FBI.Docker.stop_container(cid, t: 10)
    {:reply, :ok, %{state | cancelled: true}}
  end

  def handle_call(:cancel, _from, state) do
    Queries.mark_finished(state.run_id, %{state: "cancelled", error: nil})
    publish_state(state.run_id)
    {:reply, :ok, %{state | cancelled: true}}
  end

  def handle_call(:mark_cancelled, _from, state) do
    was = state.cancelled
    {:reply, was, %{state | cancelled: true}}
  end

  def handle_call(:get_rate_limit, _from, state) do
    {:reply, state.last_rate_limit, state}
  end

  @impl true
  def handle_info({ref, _result}, %{lifecycle_task_ref: ref} = state) do
    Process.demonitor(ref, [:flush])
    {:stop, :normal, %{state | lifecycle_task_ref: nil}}
  end

  def handle_info({:DOWN, ref, :process, _, reason}, %{lifecycle_task_ref: ref} = state) do
    Logger.error("RunServer lifecycle task crashed for run #{state.run_id}: #{inspect(reason)}")
    {:stop, :normal, %{state | lifecycle_task_ref: nil}}
  end

  def handle_info(_, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    case Queries.get(state.run_id) do
      {:ok, %{state: s}} when s in ["starting", "running", "waiting"] ->
        Queries.mark_finished(state.run_id, %{
          state: "failed",
          error: "orchestrator process crashed"
        })

        publish_state(state.run_id)

      _ ->
        :ok
    end
  end

  # ---------------------------------------------------------------------------
  # Lifecycle implementations
  # ---------------------------------------------------------------------------

  defp run_lifecycle(:launch, run_id, config, server_pid) do
    with {:ok, run} <- Queries.get(run_id),
         {:ok, project} <- FBI.Projects.Queries.get(run.project_id) do
      log_path = run.log_path
      on_bytes = make_on_bytes(run_id, log_path)
      on_bytes.("[fbi] resolving image\n")

      {:ok, image_tag} =
        FBI.Orchestrator.ImageBuilder.resolve(%{
          project_id: project.id,
          devcontainer_files: nil,
          override_json: project.devcontainer_override_json,
          on_log: on_bytes
        })

      on_bytes.("[fbi] image: #{image_tag}\n")

      runs_dir = config.runs_dir
      mount_dir = ensure_dir(SessionId.mount_dir(runs_dir, run_id), 0o777)
      state_dir = ensure_dir(SessionId.state_dir(runs_dir, run_id), 0o777)
      _uploads_dir = ensure_dir(SessionId.uploads_dir(runs_dir, run_id), 0o755)
      scripts_dir = ensure_scripts_dir(SessionId.scripts_dir(runs_dir, run_id), config)

      wip_repo_path = FBI.Orchestrator.WipRepo.init(runs_dir, run_id)

      project_secrets = FBI.Settings.SecretsQueries.decrypt_all(project.id)
      effective_mcps = FBI.Mcp.Queries.list_effective(project.id)
      settings = FBI.Settings.Queries.get()
      mem_mb = project.mem_mb || config.container_mem_mb
      cpus = project.cpus || config.container_cpus
      pids = project.pids_limit || config.container_pids

      preamble = build_preamble(project, run, run_id)

      on_bytes.("[fbi] starting container\n")

      container_spec =
        build_container_spec(%{
          image_tag: image_tag,
          run_id: run_id,
          run: run,
          project: project,
          mem_mb: mem_mb,
          cpus: cpus,
          pids: pids,
          mount_dir: mount_dir,
          state_dir: state_dir,
          scripts_dir: scripts_dir,
          wip_path: wip_repo_path,
          project_secrets: project_secrets,
          config: config,
          resume_session_id: nil
        })

      {:ok, container_id} = FBI.Docker.create_container(container_spec)

      inject_run_files(
        container_id,
        run,
        project,
        preamble,
        settings,
        effective_mcps,
        project_secrets,
        config
      )

      {:ok, attach_socket} = FBI.Docker.attach_container(container_id)
      :ok = set_container(server_pid, container_id, attach_socket)

      reader = Task.async(fn -> read_stdout_loop(attach_socket, run_id, on_bytes) end)

      _limit_monitor_pid =
        start_limit_monitor(run_id, mount_dir, container_id, attach_socket, settings, on_bytes)

      :ok = FBI.Docker.start_container(container_id)
      clear_runtime_sentinels(state_dir)
      _runtime_watcher = start_runtime_watcher(run_id, state_dir)

      Queries.mark_starting_from_queued(run_id, container_id)
      publish_state(run_id)

      {:ok, tailer} = start_usage_tailer(run_id, mount_dir)
      {:ok, title_watcher} = start_title_watcher(run_id, state_dir)
      {:ok, safeguard_watcher} = start_safeguard_watcher(run_id, wip_repo_path, run.branch_name)
      {:ok, mirror_poller} = start_mirror_poller(run_id, state_dir)

      result =
        await_and_complete(run_id, container_id, on_bytes, settings, config, server_pid)

      stop_watchers([tailer, title_watcher, safeguard_watcher, mirror_poller])
      Task.shutdown(reader, :brutal_kill)
      flush_task_messages(reader.ref)
      FBI.Docker.remove_container(container_id, force: true, v: true)
      ScreenState.clear(run_id)

      result
    else
      _ ->
        Logger.error("RunServer: run #{run_id} or project not found at launch")
        :error
    end
  end

  defp run_lifecycle(:resume, run_id, config, server_pid) do
    with {:ok, run} <- Queries.get(run_id) do
      log_path = run.log_path
      on_bytes = make_on_bytes(run_id, log_path)
      settings = FBI.Settings.Queries.get()

      on_bytes.(
        "\n[fbi] resuming (attempt #{run.resume_attempts} of #{settings.auto_resume_max_attempts})\n"
      )

      {:ok, project} = FBI.Projects.Queries.get(run.project_id)
      runs_dir = config.runs_dir
      mount_dir = ensure_dir(SessionId.mount_dir(runs_dir, run_id), 0o777)
      state_dir = ensure_dir(SessionId.state_dir(runs_dir, run_id), 0o777)
      scripts_dir = ensure_scripts_dir(SessionId.scripts_dir(runs_dir, run_id), config)
      wip_repo_path = FBI.Orchestrator.WipRepo.init(runs_dir, run_id)

      project_secrets = FBI.Settings.SecretsQueries.decrypt_all(project.id)
      effective_mcps = FBI.Mcp.Queries.list_effective(project.id)
      mem_mb = project.mem_mb || config.container_mem_mb
      cpus = project.cpus || config.container_cpus
      pids = project.pids_limit || config.container_pids

      container_spec =
        build_container_spec(%{
          image_tag: resolve_image_tag(project, config, on_bytes),
          run_id: run_id,
          run: run,
          project: project,
          mem_mb: mem_mb,
          cpus: cpus,
          pids: pids,
          mount_dir: mount_dir,
          state_dir: state_dir,
          scripts_dir: scripts_dir,
          wip_path: wip_repo_path,
          project_secrets: project_secrets,
          config: config,
          resume_session_id: run.claude_session_id
        })

      {:ok, container_id} = FBI.Docker.create_container(container_spec)

      if is_nil(run.claude_session_id) do
        preamble = build_preamble(project, run, run_id)

        inject_run_files(
          container_id,
          run,
          project,
          preamble,
          settings,
          effective_mcps,
          project_secrets,
          config
        )
      else
        inject_claude_settings(container_id, project, effective_mcps, project_secrets, config)
      end

      {:ok, attach_socket} = FBI.Docker.attach_container(container_id)
      :ok = set_container(server_pid, container_id, attach_socket)

      reader = Task.async(fn -> read_stdout_loop(attach_socket, run_id, on_bytes) end)

      _limit_monitor_pid =
        start_limit_monitor(run_id, mount_dir, container_id, attach_socket, settings, on_bytes)

      :ok = FBI.Docker.start_container(container_id)
      clear_runtime_sentinels(state_dir)
      _runtime_watcher = start_runtime_watcher(run_id, state_dir)

      Queries.mark_starting_for_resume(run_id, container_id)
      publish_state(run_id)

      {:ok, tailer} = start_usage_tailer(run_id, mount_dir)
      {:ok, title_watcher} = start_title_watcher(run_id, state_dir)
      {:ok, safeguard_watcher} = start_safeguard_watcher(run_id, wip_repo_path, run.branch_name)
      {:ok, mirror_poller} = start_mirror_poller(run_id, state_dir)

      result =
        await_and_complete(run_id, container_id, on_bytes, settings, config, server_pid)

      stop_watchers([tailer, title_watcher, safeguard_watcher, mirror_poller])
      Task.shutdown(reader, :brutal_kill)
      flush_task_messages(reader.ref)
      FBI.Docker.remove_container(container_id, force: true, v: true)
      ScreenState.clear(run_id)
      result
    else
      _ -> :error
    end
  end

  defp run_lifecycle(:continue, run_id, config, server_pid) do
    with {:ok, run} <- Queries.get(run_id) do
      log_path = run.log_path
      on_bytes = make_on_bytes(run_id, log_path)
      on_bytes.("\n[fbi] continuing from session #{run.claude_session_id}\n")

      {:ok, project} = FBI.Projects.Queries.get(run.project_id)
      runs_dir = config.runs_dir
      mount_dir = ensure_dir(SessionId.mount_dir(runs_dir, run_id), 0o777)
      state_dir = ensure_dir(SessionId.state_dir(runs_dir, run_id), 0o777)
      scripts_dir = ensure_scripts_dir(SessionId.scripts_dir(runs_dir, run_id), config)
      wip_repo_path = FBI.Orchestrator.WipRepo.init(runs_dir, run_id)

      project_secrets = FBI.Settings.SecretsQueries.decrypt_all(project.id)
      effective_mcps = FBI.Mcp.Queries.list_effective(project.id)
      settings = FBI.Settings.Queries.get()
      mem_mb = project.mem_mb || config.container_mem_mb
      cpus = project.cpus || config.container_cpus
      pids = project.pids_limit || config.container_pids

      container_spec =
        build_container_spec(%{
          image_tag: resolve_image_tag(project, config, on_bytes),
          run_id: run_id,
          run: run,
          project: project,
          mem_mb: mem_mb,
          cpus: cpus,
          pids: pids,
          mount_dir: mount_dir,
          state_dir: state_dir,
          scripts_dir: scripts_dir,
          wip_path: wip_repo_path,
          project_secrets: project_secrets,
          config: config,
          resume_session_id: run.claude_session_id
        })

      {:ok, container_id} = FBI.Docker.create_container(container_spec)
      inject_claude_settings(container_id, project, effective_mcps, project_secrets, config)

      {:ok, attach_socket} = FBI.Docker.attach_container(container_id)
      :ok = set_container(server_pid, container_id, attach_socket)

      reader = Task.async(fn -> read_stdout_loop(attach_socket, run_id, on_bytes) end)

      _limit_monitor_pid =
        start_limit_monitor(run_id, mount_dir, container_id, attach_socket, settings, on_bytes)

      :ok = FBI.Docker.start_container(container_id)
      clear_runtime_sentinels(state_dir)
      _runtime_watcher = start_runtime_watcher(run_id, state_dir)

      Queries.mark_starting_container(run_id, container_id)
      publish_state(run_id)

      {:ok, tailer} = start_usage_tailer(run_id, mount_dir)
      {:ok, title_watcher} = start_title_watcher(run_id, state_dir)
      {:ok, safeguard_watcher} = start_safeguard_watcher(run_id, wip_repo_path, run.branch_name)
      {:ok, mirror_poller} = start_mirror_poller(run_id, state_dir)

      result =
        await_and_complete(run_id, container_id, on_bytes, settings, config, server_pid)

      stop_watchers([tailer, title_watcher, safeguard_watcher, mirror_poller])
      Task.shutdown(reader, :brutal_kill)
      flush_task_messages(reader.ref)
      FBI.Docker.remove_container(container_id, force: true, v: true)
      ScreenState.clear(run_id)
      result
    else
      _ -> :error
    end
  end

  defp run_lifecycle(:reattach, run_id, config, server_pid) do
    with {:ok, run} <- Queries.get(run_id) do
      log_path = run.log_path
      on_bytes = make_on_bytes(run_id, log_path)
      on_bytes.("\n[fbi] reattached after orchestrator restart\n")

      container_id = run.container_id
      settings = FBI.Settings.Queries.get()
      runs_dir = config.runs_dir
      mount_dir = SessionId.mount_dir(runs_dir, run_id)
      state_dir = SessionId.state_dir(runs_dir, run_id)

      {:ok, stdin_socket} = FBI.Docker.attach_container_stdin_only(container_id)
      :ok = set_container(server_pid, container_id, stdin_socket)

      since_sec = div(run.started_at || System.os_time(:millisecond), 1000)
      {:ok, log_socket} = FBI.Docker.container_logs(container_id, since: since_sec)
      # Reader exits naturally when log_socket closes (container removal). The
      # surrounding lifecycle Task that owns this reader is short-lived: when it
      # returns, the Task.async link tears the reader down and any unawaited
      # reply messages die with the parent Task's mailbox.
      _log_reader = Task.async(fn -> read_stdout_loop(log_socket, run_id, on_bytes) end)

      wip_repo_path = FBI.Orchestrator.WipRepo.path(runs_dir, run_id)

      _limit_monitor_pid =
        start_limit_monitor(run_id, mount_dir, container_id, stdin_socket, settings, on_bytes)

      _runtime_watcher = start_runtime_watcher(run_id, state_dir)

      {:ok, tailer} = start_usage_tailer(run_id, mount_dir)
      {:ok, title_watcher} = start_title_watcher(run_id, state_dir)
      {:ok, safeguard_watcher} = start_safeguard_watcher(run_id, wip_repo_path, run.branch_name)
      {:ok, mirror_poller} = start_mirror_poller(run_id, state_dir)

      result =
        await_and_complete(run_id, container_id, on_bytes, settings, config, server_pid)

      stop_watchers([tailer, title_watcher, safeguard_watcher, mirror_poller])
      FBI.Docker.remove_container(container_id, force: true, v: true)
      ScreenState.clear(run_id)
      result
    else
      _ -> :error
    end
  end

  # ---------------------------------------------------------------------------
  # Core completion logic
  # ---------------------------------------------------------------------------

  defp await_and_complete(run_id, container_id, on_bytes, settings, config, _server_pid) do
    {:ok, status_code} = FBI.Docker.wait_container(container_id)

    {:ok, inspect_result} = FBI.Docker.inspect_container(container_id)
    oom_killed = get_in(inspect_result, ["State", "OOMKilled"]) == true

    result_text = read_file_from_container(container_id, "/tmp/result.json")
    classification = ResultParser.classify_result_json(result_text)

    parsed =
      case ResultParser.parse_result_json(result_text) do
        {:ok, r} -> r
        :error -> nil
      end

    {:ok, run} = Queries.get(run_id)
    mount_dir = SessionId.mount_dir(config.runs_dir, run_id)

    if session_id = SessionId.scan_session_id(mount_dir) do
      Queries.set_claude_session_id(run_id, session_id)
    end

    if classification.kind == :resume_failed do
      err_msg = "restore failed (#{classification.error})"
      on_bytes.("\n[fbi] #{err_msg}\n")
      Queries.mark_resume_failed(run_id, err_msg)
      publish_state(run_id)
      :ok
    else
      was_cancelled = mark_cancelled(run_id)
      failed_normally = not (status_code == 0 && parsed != nil && parsed.push_exit == 0)

      if failed_normally and not was_cancelled and settings.auto_resume_enabled do
        log_tail = LogStore.read_all(run.log_path)
        snap = get_last_rate_limit(run_id)

        rls_input =
          if snap,
            do:
              Map.take(snap, [
                :requests_remaining,
                :requests_limit,
                :tokens_remaining,
                :tokens_limit,
                :reset_at
              ]),
            else: nil

        verdict = ResumeDetector.classify(log_tail, rls_input, System.os_time(:millisecond))

        if verdict.kind == :rate_limit and verdict.reset_at do
          {:ok, fresh_run} = Queries.get(run_id)

          if fresh_run.resume_attempts + 1 > settings.auto_resume_max_attempts do
            msg =
              "rate limited; exceeded auto-resume cap (#{settings.auto_resume_max_attempts} attempts)"

            on_bytes.("\n[fbi] #{msg}\n")
            Queries.mark_finished(run_id, %{state: "failed", error: msg})
            if parsed && parsed.title, do: Queries.update_title_if_unlocked(run_id, parsed.title)
            publish_state(run_id)
          else
            Queries.mark_awaiting_resume(run_id, %{
              next_resume_at: verdict.reset_at,
              last_limit_reset_at: verdict.reset_at
            })

            on_bytes.(
              "\n[fbi] awaiting resume until #{DateTime.from_unix!(div(verdict.reset_at, 1000)) |> DateTime.to_iso8601()}\n"
            )

            publish_state(run_id)
            ResumeScheduler.schedule(FBI.Orchestrator.ResumeScheduler, run_id, verdict.reset_at)
            :ok
          end
        else
          finalize_run(run_id, status_code, parsed, was_cancelled, oom_killed, on_bytes, config)
        end
      else
        finalize_run(run_id, status_code, parsed, was_cancelled, oom_killed, on_bytes, config)
      end
    end
  end

  defp finalize_run(run_id, status_code, parsed, was_cancelled, oom_killed, on_bytes, config) do
    state =
      cond do
        was_cancelled -> "cancelled"
        status_code == 0 && parsed != nil && parsed.push_exit == 0 -> "succeeded"
        true -> "failed"
      end

    {:ok, run} = Queries.get(run_id)
    {:ok, project} = FBI.Projects.Queries.get(run.project_id)
    mem_mb = project.mem_mb || config.container_mem_mb

    error =
      if state == "failed" do
        cond do
          oom_killed -> "container OOM (memory cap #{mem_mb} MB)"
          parsed && parsed.push_exit != 0 -> "git push failed (code #{parsed.push_exit})"
          parsed -> "agent exit #{parsed.exit_code}"
          true -> "container exit #{status_code}"
        end
      else
        nil
      end

    branch_from_result =
      if parsed && parsed.branch && parsed.branch != "", do: parsed.branch, else: nil

    Queries.mark_finished(run_id, %{
      state: state,
      exit_code: (parsed && parsed.exit_code) || status_code,
      head_commit: (parsed && parsed.head_sha) || nil,
      branch_name: branch_from_result,
      error: error
    })

    if parsed && parsed.title do
      Queries.update_title_if_unlocked(run_id, parsed.title)
    end

    on_bytes.("\n[fbi] run #{state}\n")
    publish_state(run_id)
    :ok
  end

  # ---------------------------------------------------------------------------
  # stdout reader loop
  # ---------------------------------------------------------------------------

  defp read_stdout_loop(socket, run_id, on_bytes) do
    case :gen_tcp.recv(socket, 0, 60_000) do
      {:ok, data} ->
        on_bytes.(data)
        read_stdout_loop(socket, run_id, on_bytes)

      {:error, :timeout} ->
        read_stdout_loop(socket, run_id, on_bytes)

      {:error, _} ->
        :done
    end
  end

  # ---------------------------------------------------------------------------
  # on_bytes callback
  # ---------------------------------------------------------------------------

  defp make_on_bytes(run_id, log_path) do
    fn chunk ->
      LogStore.append(log_path, chunk)
      Phoenix.PubSub.broadcast(FBI.PubSub, "run:#{run_id}:bytes", {:bytes, chunk})
      ScreenState.feed(run_id, chunk)
    end
  end

  # ---------------------------------------------------------------------------
  # Watcher helpers
  # ---------------------------------------------------------------------------

  defp start_usage_tailer(run_id, mount_dir) do
    UsageTailer.start_link(
      dir: mount_dir,
      poll_ms: 500,
      on_usage: fn snapshot ->
        Phoenix.PubSub.broadcast(
          FBI.PubSub,
          "run:#{run_id}:events",
          {:event, %{type: "usage", snapshot: snapshot}}
        )
      end,
      on_rate_limit: fn snap ->
        case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
          [{pid, _}] -> GenServer.cast(pid, {:set_rate_limit, snap})
          [] -> :ok
        end

        if snap.reset_at, do: Queries.update_last_limit_reset_at(run_id, snap.reset_at)
      end,
      on_error: fn _reason -> :ok end
    )
  end

  defp start_title_watcher(run_id, state_dir) do
    TitleWatcher.start_link(
      path: Path.join(state_dir, "session-name"),
      poll_ms: 1000,
      on_title: fn title ->
        Queries.update_title_if_unlocked(run_id, title)

        case Queries.get(run_id) do
          {:ok, run} ->
            Phoenix.PubSub.broadcast(
              FBI.PubSub,
              "run:#{run_id}:events",
              {:event, %{type: "title", title: run.title, title_locked: run.title_locked}}
            )

          _ ->
            :ok
        end
      end
    )
  end

  defp start_safeguard_watcher(run_id, wip_repo_path, branch_name) do
    SafeguardWatcher.start_link(
      bare_dir: wip_repo_path,
      branch: branch_name || "claude/run-#{run_id}",
      on_snapshot: fn snap ->
        case Queries.get(run_id) do
          {:ok, run} ->
            Phoenix.PubSub.broadcast(FBI.PubSub, "run:#{run_id}:events", {
              :event,
              %{
                type: "changes",
                branch_name: run.branch_name,
                branch_base: snap.branch_base,
                commits: [],
                uncommitted: snap.dirty,
                integrations: %{},
                dirty_submodules: [],
                children: []
              }
            })

          _ ->
            :ok
        end
      end
    )
  end

  defp start_mirror_poller(run_id, state_dir) do
    MirrorStatusPoller.start_link(
      path: Path.join(state_dir, "mirror-status"),
      poll_ms: 1000,
      on_change: fn status -> Queries.set_mirror_status(run_id, status) end
    )
  end

  defp start_limit_monitor(_run_id, mount_dir, container_id, attach_socket, settings, on_bytes) do
    {:ok, nudge_worker} = FBI.Orchestrator.NudgeWorker.start_link()

    {:ok, pid} =
      LimitMonitor.start_link(
        mount_dir: mount_dir,
        on_detect: fn ->
          if settings.auto_resume_enabled do
            :gen_tcp.send(attach_socket, <<3>>)
            FBI.Orchestrator.NudgeWorker.schedule_second_ctrlc(nudge_worker, attach_socket, 500)

            FBI.Orchestrator.NudgeWorker.schedule_stop_container(
              nudge_worker,
              container_id,
              30_000
            )

            on_bytes.("\n[fbi] limit detected; nudging Claude to exit\n")
          end
        end
      )

    pid
  end

  defp start_runtime_watcher(run_id, state_dir) do
    {:ok, pid} =
      RuntimeStateWatcher.start_link(
        waiting_path: Path.join(state_dir, "waiting"),
        prompted_path: Path.join(state_dir, "prompted"),
        poll_ms: 500,
        on_change: fn
          :running ->
            Queries.mark_running(run_id)
            publish_state(run_id)

          :waiting ->
            Queries.mark_waiting(run_id)
            publish_state(run_id)

          _ ->
            :ok
        end
      )

    pid
  end

  defp stop_watchers(pids) do
    Enum.each(pids, fn pid ->
      if is_pid(pid) and Process.alive?(pid) do
        try do
          GenServer.stop(pid, :normal, 1_000)
        catch
          :exit, _ -> :ok
        end
      end
    end)
  end

  # ---------------------------------------------------------------------------
  # Container helpers
  # ---------------------------------------------------------------------------

  defp resolve_image_tag(project, _config, on_bytes) do
    {:ok, tag} =
      FBI.Orchestrator.ImageBuilder.resolve(%{
        project_id: project.id,
        devcontainer_files: nil,
        override_json: project.devcontainer_override_json,
        on_log: on_bytes
      })

    tag
  end

  defp build_container_spec(opts) do
    %{
      run_id: run_id,
      run: run,
      project: project,
      image_tag: image_tag,
      mem_mb: mem_mb,
      cpus: cpus,
      pids: pids,
      mount_dir: mount_dir,
      state_dir: state_dir,
      scripts_dir: scripts_dir,
      wip_path: wip_path,
      project_secrets: project_secrets,
      config: config,
      resume_session_id: resume_session_id
    } = opts

    host_runs_dir = config[:host_runs_dir] || config.runs_dir

    to_bind_host = fn local ->
      if host_runs_dir != config.runs_dir and String.starts_with?(local, config.runs_dir) do
        host_runs_dir <> String.slice(local, byte_size(config.runs_dir), byte_size(local))
      else
        local
      end
    end

    env = [
      "RUN_ID=#{run_id}",
      "REPO_URL=#{project.repo_url}",
      "DEFAULT_BRANCH=#{project.default_branch}",
      "GIT_AUTHOR_NAME=#{project.git_author_name || config.git_author_name}",
      "GIT_AUTHOR_EMAIL=#{project.git_author_email || config.git_author_email}",
      "FBI_MARKETPLACES=#{Enum.join(project.marketplaces || [], "\n")}",
      "FBI_PLUGINS=#{Enum.join(project.plugins || [], "\n")}",
      "IS_SANDBOX=1"
    ]

    env = if run.branch_name, do: ["FBI_BRANCH=#{run.branch_name}" | env], else: env

    env =
      if resume_session_id, do: ["FBI_RESUME_SESSION_ID=#{resume_session_id}" | env], else: env

    env = env ++ Enum.map(project_secrets, fn {k, v} -> "#{k}=#{v}" end)

    binds = [
      "#{to_bind_host.(Path.join(scripts_dir, "supervisor.sh"))}:/usr/local/bin/supervisor.sh:ro",
      "#{to_bind_host.(Path.join(scripts_dir, "finalizeBranch.sh"))}:/usr/local/bin/fbi-finalize-branch.sh:ro",
      "#{to_bind_host.(Path.join(scripts_dir, "fbi-history-op.sh"))}:/usr/local/bin/fbi-history-op.sh:ro",
      "#{to_bind_host.(wip_path)}:/home/agent/.safeguard.git:rw",
      "#{to_bind_host.(mount_dir)}:/home/agent/.claude/projects/",
      "#{to_bind_host.(state_dir)}:/fbi-state/"
    ]

    binds = binds ++ claude_auth_mounts(config)
    binds = binds ++ docker_socket_mounts(config)

    %{
      "Image" => image_tag,
      "name" => "fbi-run-#{run_id}-#{System.os_time(:millisecond)}",
      "User" => "agent",
      "Env" => env,
      "Tty" => true,
      "OpenStdin" => true,
      "StdinOnce" => false,
      "Entrypoint" => ["/usr/local/bin/supervisor.sh"],
      "HostConfig" => %{
        "AutoRemove" => false,
        "Memory" => mem_mb * 1024 * 1024,
        "NanoCpus" => round(cpus * 1.0e9),
        "PidsLimit" => pids,
        "Binds" => binds
      }
    }
  end

  defp inject_run_files(
         container_id,
         run,
         project,
         preamble,
         settings,
         effective_mcps,
         project_secrets,
         config
       ) do
    FBI.Docker.inject_files(container_id, "/fbi", %{
      "prompt.txt" => run.prompt || "",
      "instructions.txt" => project.instructions || "",
      "global.txt" => settings.global_prompt || "",
      "preamble.txt" => preamble
    })

    inject_claude_settings(container_id, project, effective_mcps, project_secrets, config)
  end

  defp inject_claude_settings(container_id, _project, effective_mcps, project_secrets, config) do
    claude_json = ClaudeJson.build(config.host_claude_dir, effective_mcps, project_secrets)
    FBI.Docker.inject_files(container_id, "/home/agent", %{".claude.json" => claude_json}, 1000)
    claude_settings = ClaudeJson.build_claude_settings_json()

    FBI.Docker.inject_files(
      container_id,
      "/home/agent/.claude",
      %{"settings.json" => claude_settings},
      1000
    )
  end

  defp build_preamble(project, run, run_id) do
    branch = run.branch_name || "claude/run-#{run_id}"

    [
      "You are working in /workspace on #{project.repo_url}.",
      "Its default branch is #{project.default_branch}. Do NOT commit to #{project.default_branch}.",
      "You are working on branch `#{branch}`. Make all commits here.",
      "Do NOT push to or modify any other branch.",
      "",
      "As soon as you understand the task, write a short name (4–8 words,",
      "imperative, no trailing punctuation) describing this session to",
      "`/fbi-state/session-name`. You may overwrite it later if your",
      "understanding changes. Also include a refined `title` field in the",
      "final result JSON.",
      ""
    ]
    |> Enum.join("\n")
  end

  defp read_file_from_container(container_id, path) do
    {:ok, exec_id} = FBI.Docker.exec_create(container_id, ["cat", path])
    {:ok, output} = FBI.Docker.exec_start(exec_id, timeout_ms: 5_000)
    output
  rescue
    _ -> ""
  end

  defp ensure_dir(path, mode) do
    File.mkdir_p!(path)
    File.chmod!(path, mode)
    path
  end

  defp ensure_scripts_dir(dir, config) do
    File.mkdir_p!(dir)

    Enum.each(
      [
        {"supervisor.sh", config[:supervisor_sh_path]},
        {"finalizeBranch.sh", config[:finalize_branch_sh_path]},
        {"fbi-history-op.sh", config[:history_op_sh_path]}
      ],
      fn {dest, src} ->
        if src && File.exists?(src) do
          File.cp!(src, Path.join(dir, dest))
          File.chmod!(Path.join(dir, dest), 0o755)
        end
      end
    )

    dir
  end

  defp clear_runtime_sentinels(state_dir) do
    File.rm(Path.join(state_dir, "waiting"))
    File.rm(Path.join(state_dir, "prompted"))
    :ok
  end

  defp claude_auth_mounts(config) do
    creds = Path.join(config.host_claude_dir, ".credentials.json")

    if File.exists?(creds) do
      bind_source =
        Path.join(
          config[:host_bind_claude_dir] || config.host_claude_dir,
          ".credentials.json"
        )

      ["#{bind_source}:/home/agent/.claude/.credentials.json"]
    else
      []
    end
  end

  defp docker_socket_mounts(config) do
    socket = config[:host_docker_socket] || "/var/run/docker.sock"
    if File.exists?(socket), do: ["#{socket}:/var/run/docker.sock"], else: []
  end

  defp flush_task_messages(ref) do
    receive do
      {^ref, _} -> flush_task_messages(ref)
      {:DOWN, ^ref, _, _, _} -> flush_task_messages(ref)
    after
      0 -> :ok
    end
  end
end
