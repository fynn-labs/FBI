defmodule FBI.Orchestrator do
  @moduledoc """
  Public API for orchestrating runs. All lifecycle operations delegate to
  per-run RunServer GenServers managed by RunSupervisor.
  """

  alias FBI.Orchestrator.{
    RunSupervisor,
    RunServer,
    ResumeScheduler,
    WipRepo,
    ImageGc,
    ImageBuilder
  }

  alias FBI.Runs.Queries
  alias FBI.Projects.Queries, as: PQ

  @doc "Provision the WIP bare repo for a run (called at run creation time)."
  def init_safeguard(run_id) do
    config = get_config()
    WipRepo.init(config.runs_dir, run_id)
    :ok
  end

  @doc "Launch a queued run. Fire-and-forget; state transitions go through DB."
  def launch(run_id) do
    config = get_config()

    case RunSupervisor.start_run(run_id, :launch, config) do
      {:ok, _pid} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  @doc "Resume an awaiting_resume run."
  def resume(run_id) do
    config = get_config()

    case Queries.get(run_id) do
      {:ok, %{state: "awaiting_resume"}} ->
        RunSupervisor.start_run(run_id, :resume, config)
        :ok
      _ ->
        :ok
    end
  end

  @doc "Continue a terminal run (already flipped to :starting by caller)."
  def continue_run(run_id) do
    config = get_config()

    case RunSupervisor.start_run(run_id, :continue, config) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  @doc "Mark a terminal run as starting for continue (synchronous DB flip)."
  def mark_starting_for_continue_request(run_id) do
    Queries.mark_starting_for_continue_request(run_id)
    RunServer.publish_state(run_id)
  end

  @doc "Cancel an active or awaiting_resume run."
  def cancel(run_id) do
    case Queries.get(run_id) do
      {:ok, %{state: "awaiting_resume"}} ->
        ResumeScheduler.cancel(FBI.Orchestrator.ResumeScheduler, run_id)
        Queries.mark_finished(run_id, %{state: "cancelled", error: nil})
        RunServer.publish_state(run_id)
        :ok

      _ ->
        RunServer.cancel(run_id)
        :ok
    end
  end

  def write_stdin(run_id, bytes) do
    RunServer.write_stdin(run_id, bytes)
  end

  def resize(run_id, cols, rows) do
    RunServer.resize(run_id, cols, rows)
  end

  def fire_resume_now(run_id) do
    ResumeScheduler.fire_now(FBI.Orchestrator.ResumeScheduler, run_id)
  end

  @doc "Delete a terminal run: log file + wip repo + DB row."
  def delete_run(run_id) do
    config = get_config()

    case Queries.get(run_id) do
      {:ok, %{state: s}} when s in ["starting", "running", "waiting"] ->
        {:error, :run_active}

      {:ok, run} ->
        if run.log_path, do: File.rm(run.log_path)
        WipRepo.remove(config.runs_dir, run_id)
        Queries.delete(run_id)

      _ ->
        :ok
    end
  end

  @doc "Run image GC. Returns %{deleted_count, deleted_bytes}."
  def run_gc_once do
    config = get_config()
    postbuild = read_postbuild(config)
    projects = PQ.list()

    result =
      ImageGc.sweep(
        projects,
        System.os_time(:millisecond),
        ImageBuilder.always_packages(),
        postbuild
      )

    result
  end

  @doc "Recover runs left in active states from a previous orchestrator instance."
  def recover do
    config = get_config()

    live =
      Queries.list_by_state("starting") ++
        Queries.list_by_state("running") ++
        Queries.list_by_state("waiting")

    for run <- live do
      if is_nil(run.container_id) do
        Queries.mark_finished(run.id, %{
          state: "failed",
          error: "orchestrator lost container (no container_id)"
        })
      else
        case FBI.Docker.inspect_container(run.container_id) do
          {:ok, _} ->
            case Registry.lookup(FBI.Orchestrator.Registry, run.id) do
              [] -> RunSupervisor.start_run(run.id, :reattach, config)
              _ -> :already_running
            end

          _ ->
            Queries.mark_finished(run.id, %{
              state: "failed",
              error: "orchestrator lost container (container gone)"
            })
        end
      end
    end

    :ok
  end

  @doc "Rehydrate resume schedules from DB after restart."
  def rehydrate_schedules do
    awaiting = Queries.list_awaiting()
    ResumeScheduler.rehydrate(FBI.Orchestrator.ResumeScheduler, awaiting)
  end

  defp get_config do
    Application.get_env(:fbi, :orchestrator_config, %{
      runs_dir: Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs"),
      host_runs_dir: Application.get_env(:fbi, :host_runs_dir),
      host_claude_dir: Application.get_env(:fbi, :host_claude_dir, Path.expand("~/.claude")),
      host_bind_claude_dir: Application.get_env(:fbi, :host_bind_claude_dir),
      host_docker_socket: Application.get_env(:fbi, :docker_socket_path, "/var/run/docker.sock"),
      container_mem_mb: Application.get_env(:fbi, :container_mem_mb, 4096),
      container_cpus: Application.get_env(:fbi, :container_cpus, 2.0),
      container_pids: Application.get_env(:fbi, :container_pids, 1024),
      git_author_name: Application.get_env(:fbi, :git_author_name, "FBI Agent"),
      git_author_email: Application.get_env(:fbi, :git_author_email, "agent@fbi.local"),
      supervisor_sh_path: Application.get_env(:fbi, :supervisor_sh_path),
      finalize_branch_sh_path: Application.get_env(:fbi, :finalize_branch_sh_path),
      history_op_sh_path: Application.get_env(:fbi, :history_op_sh_path),
      postbuild_sh_path: Application.get_env(:fbi, :postbuild_sh_path)
    })
  end

  defp read_postbuild(config) do
    path = config[:postbuild_sh_path] || Path.join(:code.priv_dir(:fbi), "static/postbuild.sh")

    case File.read(path) do
      {:ok, content} -> content
      _ -> ""
    end
  end
end
