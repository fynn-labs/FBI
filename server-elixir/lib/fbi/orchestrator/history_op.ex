defmodule FBI.Orchestrator.HistoryOp do
  @moduledoc "Port of src/server/orchestrator/historyOp.ts."

  @type result ::
          {:complete, String.t()}
          | {:conflict_detected, String.t()}
          | {:gh_error, String.t()}

  @spec parse_result(String.t(), integer()) :: result()
  def parse_result(stdout, exit_code) do
    lines =
      stdout
      |> String.trim()
      |> String.split("\n")
      |> Enum.filter(&(String.starts_with?(&1, "{") and String.ends_with?(&1, "}")))

    case List.last(lines) do
      nil ->
        {:gh_error, "exit code #{exit_code}"}

      last ->
        case Jason.decode(last) do
          {:ok, %{"ok" => true, "sha" => sha}} when is_binary(sha) ->
            {:complete, sha}

          {:ok, %{"reason" => "conflict", "message" => msg}} ->
            {:conflict_detected, msg || ""}

          {:ok, %{"message" => msg}} ->
            {:gh_error, msg || "unknown"}

          {:ok, %{"reason" => reason}} ->
            {:gh_error, reason || "unknown"}

          _ ->
            {:gh_error, "unparseable: #{String.slice(last, 0, 120)}"}
        end
    end
  end

  @spec build_env(integer(), String.t(), String.t(), map(), String.t() | nil) :: map()
  def build_env(run_id, branch, default_branch, op, base_branch) do
    env = %{
      "FBI_OP" => op.op,
      "FBI_BRANCH" => branch,
      "FBI_DEFAULT" => default_branch,
      "FBI_RUN_ID" => to_string(run_id)
    }

    env =
      if op.op == "merge", do: Map.put(env, "FBI_STRATEGY", op[:strategy] || "merge"), else: env

    env =
      if op.op == "merge" and op[:strategy] == "squash" do
        Map.put(env, "FBI_SUBJECT", "Merge branch '#{branch}' (FBI run ##{run_id})")
      else
        env
      end

    env =
      if op.op == "squash-local", do: Map.put(env, "FBI_SUBJECT", op[:subject] || ""), else: env

    env = if op.op == "push-submodule", do: Map.put(env, "FBI_PATH", op[:path] || ""), else: env

    env =
      if op.op == "mirror-rebase" and base_branch do
        Map.put(env, "FBI_BASE_BRANCH", base_branch)
      else
        env
      end

    env
  end

  @doc "Run the fbi-history-op.sh script inside a live container via docker exec."
  def run_in_container(container_id, env_map, script_path) do
    env_list = Enum.map(env_map, fn {k, v} -> "#{k}=#{v}" end)

    script_content = File.read!(script_path)
    tar = FBI.Orchestrator.Tar.build(%{"fbi-history-op.sh" => script_content})

    {:ok, exec_id} =
      FBI.Docker.exec_create(container_id, ["tar", "x", "-C", "/usr/local/bin"], user: "0")

    conn = FBI.Docker.stream_exec_with_stdin(exec_id, tar)
    FBI.Docker.close_socket(conn)

    {:ok, exec_id2} =
      FBI.Docker.exec_create(container_id, ["/usr/local/bin/fbi-history-op.sh"],
        env: env_list,
        user: "agent"
      )

    {:ok, output} = FBI.Docker.exec_start(exec_id2, timeout_ms: 60_000)
    {:ok, inspect_result} = FBI.Docker.inspect_exec(exec_id2)
    exit_code = inspect_result["ExitCode"] || 1
    parse_result(output, exit_code)
  end

  @doc "Run history op in a transient alpine/git container (for finished runs)."
  def run_in_transient_container(opts) do
    _run_id = opts.run_id
    env_map = opts.env
    repo_url = opts.repo_url
    script_path = opts.history_op_script_path
    wip_path = opts.wip_path
    author_name = opts.author_name
    author_email = opts.author_email

    env_list = Enum.map(env_map, fn {k, v} -> "#{k}=#{v}" end)

    spec = %{
      "Image" => "alpine/git:latest",
      "Env" => [
        "REPO_URL=#{repo_url}",
        "GIT_AUTHOR_NAME=#{author_name}",
        "GIT_AUTHOR_EMAIL=#{author_email}" | env_list
      ],
      "Cmd" => ["/usr/local/bin/fbi-history-op.sh"],
      "HostConfig" => %{
        "AutoRemove" => true,
        "Binds" => [
          "#{script_path}:/usr/local/bin/fbi-history-op.sh:ro",
          "#{wip_path}:/wip.git:rw"
        ]
      }
    }

    {:ok, container_id} = FBI.Docker.create_container(spec)
    :ok = FBI.Docker.start_container(container_id)
    {:ok, status_code} = FBI.Docker.wait_container(container_id)
    FBI.Docker.remove_container(container_id, force: true)
    parse_result("", status_code)
  end
end
