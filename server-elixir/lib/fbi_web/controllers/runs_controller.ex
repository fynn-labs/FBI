defmodule FBIWeb.RunsController do
  @moduledoc """
  Runs read + non-orchestrator mutations. PATCH updates title; DELETE routes
  through the orchestrator: it cancels active/awaiting_resume runs (which
  cancels any ResumeScheduler timer and stops the RunServer) and then calls
  `Orchestrator.delete_run/1` to remove the WIP bare repo, the log file, and
  the DB row.

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
         {:ok, run} <- Queries.update_title(id, title, true) do
      Phoenix.PubSub.broadcast(
        FBI.PubSub,
        "run:#{id}:events",
        {:run_event, %{type: "title", title: run.title, title_locked: run.title_locked}}
      )

      json(conn, run)
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
      _ -> conn |> put_status(400) |> json(%{error: "invalid title"})
    end
  end

  def delete(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      result =
        case run.state do
          s when s in ["running", "awaiting_resume", "starting", "waiting"] ->
            FBI.Orchestrator.cancel(id)
            # cancel/1 transitions the run to 'cancelled' but leaves the row in
            # place; remove it now that the orchestrator has released its hold.
            FBI.Orchestrator.delete_run(id)

          _ ->
            FBI.Orchestrator.delete_run(id)
        end

      case result do
        {:error, :run_active} ->
          conn |> put_status(409) |> json(%{error: "run still active after cancel"})

        _ ->
          send_resp(conn, 204, "")
      end
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def create(conn, %{"id" => project_id_str} = params) do
    project_id = String.to_integer(project_id_str)

    with {:ok, _project} <- FBI.Projects.Queries.get(project_id),
         :ok <- FBI.Runs.ModelParams.validate(params) do
      do_create_with_branch_check(conn, project_id, params)
    else
      :not_found ->
        conn |> put_status(404) |> json(%{error: "not found"})

      {:error, message} when is_binary(message) ->
        conn |> put_status(400) |> json(%{error: message})
    end
  end

  defp do_create_with_branch_check(conn, project_id, params) do
    prompt = params["prompt"] || ""
    branch_hint = params["branch"] || nil
    model = params["model"]
    effort = params["effort"]
    subagent_model = params["subagent_model"]
    force = params["force"] == true

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
        do_create(conn, project_id, params, prompt, branch_hint, model, effort, subagent_model)
      end
    else
      do_create(conn, project_id, params, prompt, branch_hint, model, effort, subagent_model)
    end
  end

  defp do_create(conn, project_id, params, prompt, branch_hint, model, effort, subagent_model) do
    runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")
    draft_dir = Application.fetch_env!(:fbi, :draft_uploads_dir)
    branch_name = if branch_hint && branch_hint != "", do: branch_hint, else: "main"
    token = params["draft_token"] || ""

    with :ok <- validate_draft_token(token),
         attrs =
           build_create_attrs(project_id, prompt, branch_name, model, effort, subagent_model),
         {:ok, run} <- create_run_with_log_path(attrs, runs_dir),
         :ok <- maybe_promote_draft(token, draft_dir, runs_dir, run.id) do
      FBI.Orchestrator.init_safeguard(run.id)
      FBI.Orchestrator.launch(run.id)
      conn |> put_status(201) |> json(run)
    else
      {:error, :invalid_token} ->
        conn |> put_status(400) |> json(%{error: "invalid_token"})

      {:error, {:promotion_failed, run_id}} ->
        Queries.delete(run_id)
        File.rm_rf(Path.join(runs_dir, Integer.to_string(run_id)))
        conn |> put_status(422) |> json(%{error: "promotion_failed"})

      {:error, reason} ->
        conn |> put_status(422) |> json(%{error: inspect(reason)})
    end
  end

  defp validate_draft_token(""), do: :ok

  defp validate_draft_token(token) do
    if FBI.Uploads.Draft.valid_token?(token), do: :ok, else: {:error, :invalid_token}
  end

  defp build_create_attrs(project_id, prompt, branch_name, model, effort, subagent_model) do
    %{
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
  end

  defp create_run_with_log_path(attrs, runs_dir) do
    Queries.create_with_log_path(attrs, fn id -> Path.join(runs_dir, "#{id}.log") end)
  end

  defp maybe_promote_draft("", _draft_dir, _runs_dir, _run_id), do: :ok

  defp maybe_promote_draft(token, draft_dir, runs_dir, run_id) do
    case FBI.Uploads.Draft.promote(draft_dir, runs_dir, token, run_id) do
      {:ok, _files} -> :ok
      :ok -> :ok
      {:error, _reason} -> {:error, {:promotion_failed, run_id}}
    end
  end

  def continue_run(conn, %{"id" => id} = params) do
    run_id = String.to_integer(id)

    with {:ok, run} <- Queries.get(run_id),
         :ok <- FBI.Orchestrator.ContinueEligibility.check(run, runs_dir()),
         :ok <- FBI.Runs.ModelParams.validate(params) do
      Queries.update_model_params(run_id, %{
        model: params["model"],
        effort: params["effort"],
        subagent_model: params["subagent_model"]
      })

      FBI.Orchestrator.mark_starting_for_continue_request(run_id)
      FBI.Orchestrator.continue_run(run_id)
      send_resp(conn, 204, "")
    else
      :not_found ->
        conn |> put_status(404) |> json(%{error: "not found"})

      {:error, code, message} ->
        conn |> put_status(409) |> json(%{code: code, message: message})

      {:error, message} when is_binary(message) ->
        conn |> put_status(400) |> json(%{error: message})
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

  defp runs_dir,
    do: Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")

  defp parse_int(nil), do: nil

  defp parse_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, _} -> n
      :error -> nil
    end
  end
end
