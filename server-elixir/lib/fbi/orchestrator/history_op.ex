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

    # Extract to /tmp/ rather than /usr/local/bin/ — the latter is a bind-mount
    # from the host, so unlinkat (which tar uses to replace the file) returns EBUSY.
    # sh only needs read permission, which Tar.build's 0o6440 mode provides.
    {:ok, exec_id} =
      FBI.Docker.exec_create(container_id, ["tar", "x", "-C", "/tmp"],
        user: "0",
        stdin: true
      )

    conn = FBI.Docker.stream_exec_with_stdin(exec_id, tar)
    FBI.Docker.close_socket(conn)

    {:ok, exec_id2} =
      FBI.Docker.exec_create(container_id, ["sh", "/tmp/fbi-history-op.sh"],
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
    env_map = opts.env
    repo_url = opts.repo_url
    script_path = opts.history_op_script_path
    wip_path = opts.wip_path
    author_name = opts.author_name
    author_email = opts.author_email

    env_list = Enum.map(env_map, fn {k, v} -> "#{k}=#{v}" end)

    # Clone the repo into /workspace before running the script — same
    # preamble as the TypeScript runHistoryOpInTransientContainer.
    clone_cmd =
      Enum.join(
        [
          "set -e",
          "git clone --quiet \"$REPO_URL\" . >/dev/null 2>&1",
          "git config user.name \"$GIT_AUTHOR_NAME\"",
          "git config user.email \"$GIT_AUTHOR_EMAIL\"",
          "/usr/local/bin/fbi-history-op.sh"
        ],
        "; "
      )

    spec = %{
      "Image" => "alpine/git:latest",
      # Docker creates this directory when starting the container.
      "WorkingDir" => "/workspace",
      "Env" => [
        "REPO_URL=#{repo_url}",
        "GIT_AUTHOR_NAME=#{author_name}",
        "GIT_AUTHOR_EMAIL=#{author_email}" | env_list
      ],
      "Cmd" => ["/bin/sh", "-c", clone_cmd],
      "HostConfig" => %{
        # Keep the container until we've read its logs; remove manually below.
        "AutoRemove" => false,
        "Binds" => [
          "#{script_path}:/usr/local/bin/fbi-history-op.sh:ro",
          # Mount safeguard at /safeguard — the path the script checks.
          "#{wip_path}:/safeguard:rw"
        ]
      }
    }

    {:ok, container_id} = FBI.Docker.create_container(spec)
    :ok = FBI.Docker.start_container(container_id)
    # Open the log stream before the container can exit so we don't race
    # with AutoRemove. Docker's follow=1 keeps the connection open until
    # the container exits, so read_container_stdout/1 blocks until then.
    {:ok, logs_conn} = FBI.Docker.container_logs(container_id)
    stdout = read_container_stdout(logs_conn)
    {:ok, status_code} = FBI.Docker.wait_container(container_id)
    FBI.Docker.remove_container(container_id, force: true)
    parse_result(stdout, status_code)
  end

  # Read Docker-multiplexed log stream until the container exits (EOF).
  defp read_container_stdout(conn, acc \\ "") do
    case FBI.Docker.recv_chunked(conn) do
      {:ok, data} -> read_container_stdout(conn, acc <> strip_docker_frames(data))
      :eof -> acc
      {:error, _} -> acc
    end
  end

  # Strip Docker multiplexed-stream 8-byte frame headers, returning payload.
  defp strip_docker_frames(<<>>), do: ""

  defp strip_docker_frames(<<_type, 0, 0, 0, size::32-big, rest::binary>>)
       when byte_size(rest) >= size do
    <<payload::binary-size(size), remainder::binary>> = rest
    payload <> strip_docker_frames(remainder)
  end

  defp strip_docker_frames(data), do: data
end
