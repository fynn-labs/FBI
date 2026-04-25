defmodule FBIWeb.HistoryController do
  use FBIWeb, :controller

  alias FBI.Runs.Queries, as: RunQ
  alias FBI.Projects.Queries, as: PQ
  alias FBI.Orchestrator.HistoryOp
  alias FBI.Orchestrator.WipRepo

  def create(conn, %{"id" => id_str}) do
    run_id = String.to_integer(id_str)

    case RunQ.get(run_id) do
      :not_found ->
        conn |> put_status(404) |> json(%{error: "not found"})

      {:ok, run} ->
        cond do
          is_nil(run.branch_name) or run.branch_name == "" ->
            conn |> put_status(400) |> json(%{kind: "invalid", message: "run has no branch"})

          not is_binary(conn.body_params["op"]) ->
            conn |> put_status(400) |> json(%{kind: "invalid", message: "op required"})

          true ->
            handle_op(conn, run, conn.body_params)
        end
    end
  end

  defp handle_op(conn, run, %{"op" => "polish"}) do
    project = get_project(run.project_id)
    default_branch = (project && project.default_branch) || "main"
    args = %{"branch" => run.branch_name, "default" => default_branch}
    child_id = spawn_sub_run(run, "polish", args)
    json(conn, %{kind: "agent", child_run_id: child_id})
  end

  defp handle_op(conn, run, %{"op" => "merge"} = body) do
    project = get_project(run.project_id)
    default_branch = (project && project.default_branch) || "main"
    # default_merge_strategy is not in the Elixir schema — always default to "squash"
    strategy = body["strategy"] || "squash"
    op = %{op: "merge", strategy: strategy}
    dispatch_history_op(conn, run, project, default_branch, op)
  end

  defp handle_op(conn, run, body) do
    project = get_project(run.project_id)
    default_branch = (project && project.default_branch) || "main"

    op = %{
      op: body["op"],
      strategy: body["strategy"],
      subject: body["subject"],
      path: body["path"]
    }

    dispatch_history_op(conn, run, project, default_branch, op)
  end

  defp dispatch_history_op(conn, run, project, default_branch, op) do
    if is_nil(project) do
      conn |> put_status(503) |> json(%{kind: "git-unavailable"})
    else
      case exec_history_op(run, project, default_branch, op) do
        {:ok, {:complete, sha}} ->
          json(conn, %{kind: "complete", sha: sha})

        {:ok, {:conflict_detected, _msg}} ->
          strategy = if op.op == "merge", do: op[:strategy] || "merge", else: "merge"

          args = %{
            "branch" => run.branch_name,
            "default" => default_branch,
            "strategy" => strategy
          }

          child_id = spawn_sub_run(run, "merge-conflict", args)
          json(conn, %{kind: "conflict", child_run_id: child_id})

        {:ok, {:gh_error, message}} ->
          json(conn, %{kind: "git-error", message: message})

        {:error, _} ->
          conn |> put_status(503) |> json(%{kind: "git-unavailable"})
      end
    end
  end

  defp exec_history_op(run, project, default_branch, op) do
    env = HistoryOp.build_env(run.id, run.branch_name, default_branch, op, nil)
    runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")

    script_path =
      Application.get_env(:fbi, :history_op_sh_path) ||
        Path.join(:code.priv_dir(:fbi), "static/fbi-history-op.sh")

    active_states = ["starting", "running", "waiting"]

    try do
      result =
        if run.container_id && run.state in active_states do
          HistoryOp.run_in_container(run.container_id, env, script_path)
        else
          HistoryOp.run_in_transient_container(%{
            run_id: run.id,
            env: env,
            repo_url: project.repo_url,
            history_op_script_path: script_path,
            wip_path: WipRepo.path(runs_dir, run.id),
            author_name:
              project.git_author_name || Application.get_env(:fbi, :git_author_name, "FBI Agent"),
            author_email:
              project.git_author_email ||
                Application.get_env(:fbi, :git_author_email, "agent@fbi.local")
          })
        end

      {:ok, result}
    rescue
      e -> {:error, Exception.message(e)}
    catch
      _, reason -> {:error, inspect(reason)}
    end
  end

  defp spawn_sub_run(parent_run, kind, args) do
    runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")
    prompt = render_sub_run_prompt(kind, args)
    args_json = Jason.encode!(args)

    attrs = %{
      project_id: parent_run.project_id,
      prompt: prompt,
      branch_name: parent_run.branch_name || "main",
      log_path: "_pending_",
      parent_run_id: parent_run.id,
      kind: kind,
      kind_args_json: args_json
    }

    child_run = RunQ.create(attrs)
    log_path = Path.join(runs_dir, "#{child_run.id}.log")
    RunQ.set_log_path(child_run.id, log_path)

    Task.start(fn ->
      try do
        FBI.Orchestrator.init_safeguard(child_run.id)
        FBI.Orchestrator.launch(child_run.id)
      catch
        _, _ -> :ok
      end
    end)

    child_run.id
  end

  defp render_sub_run_prompt("merge-conflict", args) do
    branch = args["branch"] || ""
    def_branch = args["default"] || "main"
    strategy = args["strategy"] || "merge"

    "Resolve a merge conflict and complete the merge.\n" <>
      "Branch: #{branch}\nTarget: #{def_branch}\nStrategy: #{strategy}\n\n" <>
      "Steps:\n" <>
      "1. git fetch origin\n" <>
      "2. git checkout #{def_branch}\n" <>
      "3. git pull --ff-only origin #{def_branch}\n" <>
      "4. git merge --no-ff #{branch}  (or --squash / rebase per strategy)\n" <>
      "5. If conflicts: resolve them, git add, git commit.\n" <>
      "6. git push origin #{def_branch}\n" <>
      "Report the final SHA when done."
  end

  defp render_sub_run_prompt("polish", args) do
    branch = args["branch"] || ""
    def_branch = args["default"] || "main"

    "Polish the commits on branch #{branch}.\n\n" <>
      "Use git interactive rebase (GIT_SEQUENCE_EDITOR=cat git rebase -i origin/#{def_branch}) to:\n" <>
      "  1. Rewrite each commit's subject as a concise conventional-commits style summary.\n" <>
      "  2. Ensure each commit body explains the \"why\" (not just the \"what\").\n" <>
      "  3. Combine trivially-related \"wip:\" or \"fix:\" commits where appropriate.\n" <>
      "DO NOT change code — only commit metadata.\n\n" <>
      "Then: git push --force-with-lease origin #{branch}.\n" <>
      "Write a one-line summary of what you did to /fbi-state/session-name."
  end

  defp get_project(project_id) do
    case PQ.get(project_id) do
      {:ok, project} -> project
      _ -> nil
    end
  end
end
