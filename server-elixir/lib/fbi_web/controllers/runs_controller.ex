defmodule FBIWeb.RunsController do
  @moduledoc """
  Runs read + non-orchestrator mutations. PATCH updates title; DELETE removes
  the row and, for active runs, issues a Docker kill via the socket client.

  Also hosts the orchestrator-dependent create, continue_run, and resume_now
  actions added in Phase 7 / Task 20.
  """

  use FBIWeb, :controller

  alias FBI.Runs.Queries

  def index(conn, params) do
    parsed = %{
      state: params["state"],
      project_id: parse_int(params["project_id"]),
      q: params["q"],
      limit: parse_int(params["limit"]),
      offset: parse_int(params["offset"])
    }

    json(conn, Queries.list(parsed))
  end

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      json(conn, run)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def index_for_project(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      {:ok, pid} -> json(conn, Queries.list_for_project(pid))
      _ -> json(conn, [])
    end
  end

  def siblings(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, list} <- Queries.siblings(id) do
      json(conn, list)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def patch_title(conn, %{"id" => id_str} = params) do
    title =
      case params["title"] do
        t when is_binary(t) -> String.trim(t)
        _ -> nil
      end

    with {:ok, id} <- parse_id(id_str),
         true <- is_binary(title) and byte_size(title) > 0 and byte_size(title) <= 120,
         {:ok, run} <- Queries.update_title(id, title) do
      json(conn, run)
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
      _ -> conn |> put_status(400) |> json(%{error: "invalid title"})
    end
  end

  def delete(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      if run.state in ["running", "awaiting_resume", "starting"] do
        if run.container_id, do: FBI.Docker.kill(run.container_id)
      end

      Queries.delete(id)

      if run.log_path, do: File.rm(run.log_path)

      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def create(conn, %{"id" => project_id_str} = params) do
    project_id = String.to_integer(project_id_str)
    prompt = params["prompt"] || ""
    branch_hint = params["branch"] || nil
    model = params["model"]
    effort = params["effort"]
    subagent_model = params["subagent_model"]
    force = params["force"] == true

    case FBI.Projects.Queries.get(project_id) do
      :not_found ->
        conn |> put_status(404) |> json(%{error: "not found"})

      {:ok, _project} ->
        if branch_hint && branch_hint != "" && !force do
          active = Queries.list_active_by_branch(project_id, branch_hint)

          if active != [] do
            first = hd(active)

            conn
            |> put_status(409)
            |> json(%{
              error: "branch_in_use",
              active_run_id: first.id,
              message:
                "Run ##{first.id} is already using branch \"#{branch_hint}\". Pass { force: true } to start another run on the same branch anyway."
            })
          else
            do_create(conn, project_id, prompt, branch_hint, model, effort, subagent_model)
          end
        else
          do_create(conn, project_id, prompt, branch_hint, model, effort, subagent_model)
        end
    end
  end

  defp do_create(conn, project_id, prompt, branch_hint, model, effort, subagent_model) do
    runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")
    # branch_name and log_path are required by the schema. Empty string means
    # "auto-generate" — the orchestrator's preamble enrolls Claude to pick a
    # name (2–4 kebab-case words) and write it to /fbi-state/branch-name, and
    # BranchNameWatcher updates this column once Claude does. Mirrors TS
    # `branchHint = input.branch_hint ?? ''` (src/server/db/runs.ts:39).
    branch_name = if branch_hint && branch_hint != "", do: branch_hint, else: ""

    attrs = %{
      project_id: project_id,
      prompt: prompt,
      branch_name: branch_name,
      model: model,
      effort: effort,
      subagent_model: subagent_model,
      # Placeholder: overwritten immediately after insert once we know the id.
      log_path: "_pending_",
      state: "queued"
    }

    try do
      run = Queries.create(attrs)
      log_path = Path.join(runs_dir, "#{run.id}.log")
      Queries.set_log_path(run.id, log_path)
      run = %{run | log_path: log_path}
      FBI.Orchestrator.init_safeguard(run.id)
      FBI.Orchestrator.launch(run.id)
      conn |> put_status(201) |> json(run)
    rescue
      e -> conn |> put_status(422) |> json(%{error: inspect(e)})
    end
  end

  def continue_run(conn, %{"id" => id}) do
    run_id = String.to_integer(id)

    case Queries.get(run_id) do
      :not_found ->
        conn |> put_status(404) |> json(%{error: "not found"})

      {:ok, run} ->
        runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")

        case FBI.Orchestrator.ContinueEligibility.check(run, runs_dir) do
          :ok ->
            FBI.Orchestrator.mark_starting_for_continue_request(run_id)
            FBI.Orchestrator.continue_run(run_id)
            send_resp(conn, 204, "")

          {:error, code, message} ->
            conn |> put_status(409) |> json(%{code: code, message: message})
        end
    end
  end

  def resume_now(conn, %{"id" => id}) do
    run_id = String.to_integer(id)

    case Queries.get(run_id) do
      :not_found ->
        conn |> put_status(404) |> json(%{error: "not found"})

      {:ok, %{state: "awaiting_resume"}} ->
        FBI.Orchestrator.fire_resume_now(run_id)
        send_resp(conn, 204, "")

      {:ok, _} ->
        conn |> put_status(409) |> json(%{error: "not awaiting resume"})
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  defp parse_int(nil), do: nil

  defp parse_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, _} -> n
      :error -> nil
    end
  end
end
