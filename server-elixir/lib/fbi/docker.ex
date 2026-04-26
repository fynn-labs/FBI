defmodule FBI.Docker do
  @moduledoc """
  Docker Engine API client over a unix socket.
  One-shot REST calls read until socket close.
  Streaming operations (attach, logs, build) return a raw :gen_tcp socket
  that the caller owns and must close.
  """

  require Logger

  defp socket_path,
    do: Application.get_env(:fbi, :docker_socket_path, "/var/run/docker.sock")

  defp connect! do
    path = socket_path()

    case :gen_tcp.connect({:local, path}, 0, [:binary, active: false, send_timeout: 10_000]) do
      {:ok, conn} -> conn
      {:error, reason} -> raise "docker connect failed: #{inspect(reason)}"
    end
  end

  defp try_connect do
    path = socket_path()
    :gen_tcp.connect({:local, path}, 0, [:binary, active: false, send_timeout: 10_000])
  end

  defp rest(method, path, body, extra_headers, opts) do
    operation = Keyword.get(opts, :operation, :unknown)

    :telemetry.span(
      [:fbi, :docker, :request],
      %{operation: operation, method: method, path: path},
      fn ->
        conn = connect!()
        raw_body = if body, do: Jason.encode!(body), else: ""

        content_headers =
          if body != nil do
            [{"Content-Type", "application/json"}, {"Content-Length", byte_size(raw_body)}]
          else
            [{"Content-Length", "0"}]
          end

        # Connection: close so Docker shuts the socket immediately after the
        # response and our recv_until_close exits with :closed instead of waiting
        # 60s for the keep-alive idle timeout. Without this every Docker call
        # silently paid up to a minute of idle wait.
        headers =
          [{"Host", "docker"}, {"Connection", "close"} | content_headers ++ extra_headers]

        header_str = Enum.map_join(headers, "\r\n", fn {k, v} -> "#{k}: #{v}" end)
        req = "#{method} #{path} HTTP/1.1\r\n#{header_str}\r\n\r\n#{raw_body}"
        :ok = :gen_tcp.send(conn, req)
        {status, resp_body} = recv_until_close(conn, "")
        :gen_tcp.close(conn)
        {{status, resp_body}, %{operation: operation, status: status}}
      end
    )
  end

  defp stream_start(method, path, body, extra_headers, opts) do
    operation = Keyword.get(opts, :operation, :unknown)

    :telemetry.span(
      [:fbi, :docker, :request],
      %{operation: operation, method: method, path: path, streaming: true},
      fn ->
        conn = connect!()
        raw_body = if body, do: Jason.encode!(body), else: ""

        content_headers =
          if body != nil do
            [{"Content-Type", "application/json"}, {"Content-Length", byte_size(raw_body)}]
          else
            []
          end

        # Match curl/dockerode-style headers. Empirically, Docker's HTTP server
        # reacts differently to bare `Host` requests vs requests carrying
        # User-Agent + Accept; the streaming `/logs?follow=1` socket would close
        # right after the response headers without these.
        base = [
          {"Host", "docker"},
          {"User-Agent", "fbi-elixir/0.1.0"},
          {"Accept", "*/*"}
        ]

        headers = base ++ content_headers ++ extra_headers
        header_str = Enum.map_join(headers, "\r\n", fn {k, v} -> "#{k}: #{v}" end)
        req = "#{method} #{path} HTTP/1.1\r\n#{header_str}\r\n\r\n#{raw_body}"
        :ok = :gen_tcp.send(conn, req)
        {conn, %{operation: operation, streaming: true}}
      end
    )
  end

  # Read until the peer closes the connection. Uses an infinite timeout
  # because some endpoints (notably /containers/:id/wait) only respond when
  # the container actually exits, which can be arbitrarily long. A finite
  # timeout here would silently truncate the body to "" and make ok_json
  # crash with Jason.DecodeError — that's how runs 2/3 silently failed
  # 60s after launch in the original implementation.
  #
  # All callers send `Connection: close` (rest/4 unconditionally,
  # wait_container/1 explicitly), so Docker is guaranteed to close the
  # socket once the response body is complete; the kernel surfaces that
  # as `:closed` here. If the connection somehow never closes, the
  # caller's overall context (cancel call, container removal, GenServer
  # termination) is responsible for closing the socket from our side.
  defp recv_until_close(conn, acc) do
    case :gen_tcp.recv(conn, 0, :infinity) do
      {:ok, data} -> recv_until_close(conn, acc <> data)
      {:error, :closed} -> split_http(acc)
      {:error, _} -> split_http(acc)
    end
  end

  defp split_http(raw) do
    [head | tail] = String.split(raw, "\r\n\r\n", parts: 2)
    body = Enum.join(tail, "\r\n\r\n")
    [status_line | _] = String.split(head, "\r\n")
    [_, code | _] = String.split(status_line, " ", parts: 3)

    decoded =
      if String.contains?(head, "Transfer-Encoding: chunked") or
           String.contains?(head, "transfer-encoding: chunked") do
        decode_chunked(body)
      else
        body
      end

    {String.to_integer(code), decoded}
  end

  defp decode_chunked(data), do: decode_chunked(data, "")
  defp decode_chunked("", acc), do: acc
  defp decode_chunked("\r\n" <> rest, acc), do: decode_chunked(rest, acc)

  defp decode_chunked(data, acc) do
    case String.split(data, "\r\n", parts: 2) do
      [size_hex, rest] ->
        size = String.to_integer(String.trim(size_hex), 16)

        if size == 0 do
          acc
        else
          <<chunk::binary-size(size), remainder::binary>> = rest
          decode_chunked(remainder, acc <> chunk)
        end

      _ ->
        acc
    end
  end

  defp ok_json(status, body) when status in 200..299, do: {:ok, Jason.decode!(body)}
  defp ok_json(status, body), do: {:error, {status, body}}

  defp ok_unit(status, _body) when status in 200..299, do: :ok
  defp ok_unit(status, body), do: {:error, {status, body}}

  # Post-condition helpers
  # ----------------------------------------------------------------------------
  # Each side-effecting Docker call verifies the side effect actually happened
  # before returning success. The pattern: do the call, check Docker's reply,
  # then re-`inspect_container` (or equivalent) to confirm the post-condition.
  # If the post-condition fails the helper raises with a descriptive message.
  #
  # Why this exists: Docker's API has several modes where a request returns
  # success but the side effect didn't fully complete (notably the build →
  # tag race fixed in commit 15446fb). Without a post-condition check, those
  # silent failures cascade into confusing 404s several layers downstream
  # (e.g. "Could not find /fbi in container <id>" really meaning "the image
  # built for that container didn't get tagged"). Asserting at the boundary
  # keeps each fault visible at its source.
  #
  # `inspect_predicate!/3` polls inspect_container with a short retry budget
  # to absorb the brief async window between Docker acking a state change and
  # `State` reflecting it. `predicate` runs against the parsed inspect body
  # and returns true once the post-condition is met.

  @inspect_retry_attempts 30
  @inspect_retry_delay_ms 100

  defp inspect_predicate!(id, label, predicate, attempts \\ @inspect_retry_attempts) do
    case inspect_container(id) do
      {:ok, body} ->
        if predicate.(body) do
          :ok
        else
          if attempts > 0 do
            Process.sleep(@inspect_retry_delay_ms)
            inspect_predicate!(id, label, predicate, attempts - 1)
          else
            raise "docker post-condition failed for container #{id}: " <>
                    "#{label} (last state: #{inspect(body["State"])})"
          end
        end

      {:error, {404, _}} ->
        raise "docker post-condition failed: container #{id} not found while waiting for #{label}"

      {:error, reason} ->
        raise "docker inspect for post-condition '#{label}' on container #{id} failed: #{inspect(reason)}"
    end
  end

  # Verify the container is gone (inspect returns 404). Used after remove.
  defp inspect_gone!(id, attempts \\ @inspect_retry_attempts) do
    case inspect_container(id) do
      {:error, {404, _}} ->
        :ok

      {:ok, _body} ->
        if attempts > 0 do
          Process.sleep(@inspect_retry_delay_ms)
          inspect_gone!(id, attempts - 1)
        else
          raise "docker post-condition failed: container #{id} still exists after remove"
        end

      {:error, reason} ->
        raise "docker inspect after remove on #{id} failed: #{inspect(reason)}"
    end
  end

  # Container operations

  def create_container(spec) do
    # Docker /containers/create takes the name as a *query parameter*, not a
    # body field. Extract it so the user-supplied name actually sticks instead
    # of Docker assigning a random one (which made our `fbi-run-*` containers
    # show up as "eloquent_nash" etc.).
    {name, body_spec} = Map.pop(spec, "name")

    path =
      case name do
        nil -> "/containers/create"
        "" -> "/containers/create"
        n -> "/containers/create?name=#{URI.encode(n, &URI.char_unreserved?/1)}"
      end

    {status, body} = rest("POST", path, body_spec, [], operation: :create_container)

    case ok_json(status, body) do
      {:ok, %{"Id" => id}} ->
        # Boundary check: if Docker returned 201 with an ID but the container
        # isn't actually inspectable, surface that here rather than letting
        # downstream calls 404 in confusing ways.
        inspect_predicate!(id, "exists after create", fn body ->
          body["Id"] == id or String.starts_with?(id, body["Id"] || "")
        end)

        {:ok, id}

      {:ok, other} ->
        {:error, other}

      err ->
        err
    end
  end

  def start_container(id) do
    {status, body} = rest("POST", "/containers/#{id}/start", nil, [], operation: :start_container)

    case ok_unit(status, body) do
      :ok ->
        # Boundary check: Docker returns 204 once it has dispatched the start,
        # but the OCI runtime can take a few ms to flip State.Running. Poll
        # until either Running flips to true or the container has already
        # exited (in which case `start` did its job — the container's own
        # entrypoint problem is a separate concern caller code can detect via
        # wait_container).
        inspect_predicate!(id, "started", fn body ->
          state = body["State"] || %{}
          state["Running"] == true or state["Status"] in ["running", "exited", "dead"]
        end)

        :ok

      err ->
        err
    end
  end

  def stop_container(id, opts \\ []) do
    t = Keyword.get(opts, :t, 10)

    {status, body} =
      rest("POST", "/containers/#{id}/stop?t=#{t}", nil, [], operation: :stop_container)
    # No post-condition check here on purpose: stop's contract is "send
    # signals and possibly wait up to t seconds before SIGKILL". Whether the
    # process has actually exited is `wait_container/1`'s job. Adding an
    # inspect-poll here would block the cancel path's GenServer.call past
    # its 10s timeout for legitimate slow shutdowns.
    ok_unit(status, body)
  end

  def kill(container_id) when is_binary(container_id) and container_id != "" do
    case try_connect() do
      {:ok, conn} ->
        path = "/containers/#{container_id}/kill"
        req = "POST #{path} HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n"
        :gen_tcp.send(conn, req)
        :gen_tcp.close(conn)
        :ok

      {:error, reason} ->
        Logger.warning("docker kill failed: #{inspect(reason)}")
        :ok
    end
  end

  def kill(_), do: :ok

  def remove_container(id, opts \\ []) do
    force = if Keyword.get(opts, :force, false), do: "1", else: "0"
    v = if Keyword.get(opts, :v, false), do: "1", else: "0"

    {status, body} =
      rest("DELETE", "/containers/#{id}?force=#{force}&v=#{v}", nil, [],
        operation: :remove_container
      )

    case ok_unit(status, body) do
      :ok ->
        # 204 means Docker accepted the removal; the actual unlink can lag
        # by a few hundred ms while Docker tears down mounts, networks, and
        # volumes. inspect_gone!/1 polls until inspect returns 404, so a
        # subsequent caller (e.g. a fresh create_container with the same
        # name) doesn't race a stale container.
        inspect_gone!(id)
        :ok

      err ->
        err
    end
  end

  def inspect_container(id) do
    {status, body} = rest("GET", "/containers/#{id}/json", nil, [], operation: :inspect_container)
    ok_json(status, body)
  end

  def wait_container(id) do
    # Connection: close so Docker closes the socket the moment it has sent
    # the wait response, signalling the end of the body to recv_until_close.
    # Without it Docker would keep the keepalive connection open, and our
    # infinite-timeout recv would block forever waiting for a close that
    # never comes.
    conn =
      stream_start("POST", "/containers/#{id}/wait", nil, [{"Connection", "close"}],
        operation: :wait_container
      )

    {status, body} = recv_until_close(conn, "")
    :gen_tcp.close(conn)

    case ok_json(status, body) do
      {:ok, %{"StatusCode" => code}} -> {:ok, code}
      {:ok, other} -> {:error, other}
      err -> err
    end
  end

  def attach_container(id) do
    conn =
      stream_start(
        "POST",
        "/containers/#{id}/attach?stream=1&stdin=1&stdout=1&stderr=1",
        nil,
        [{"Upgrade", "tcp"}, {"Connection", "Upgrade"}],
        operation: :attach_container
      )

    skip_http_headers(conn)
    {:ok, conn}
  end

  def attach_container_stdin_only(id) do
    conn =
      stream_start(
        "POST",
        "/containers/#{id}/attach?stream=1&stdin=1&stdout=0&stderr=0",
        nil,
        [{"Upgrade", "tcp"}, {"Connection", "Upgrade"}],
        operation: :attach_container_stdin_only
      )

    skip_http_headers(conn)
    {:ok, conn}
  end

  def container_logs(id, opts \\ []) do
    since = Keyword.get(opts, :since, 0)

    conn =
      stream_start(
        "GET",
        "/containers/#{id}/logs?follow=1&stdout=1&stderr=1&since=#{since}",
        nil,
        [],
        operation: :container_logs
      )

    skip_http_headers(conn)
    {:ok, conn}
  end

  @doc """
  Read the next decoded chunk from a Docker streaming connection that uses
  HTTP/1.1 Transfer-Encoding: chunked.

  Returns `{:ok, binary}` for each chunk (empty binary excluded), `:eof` when
  the chunked terminator (`0\\r\\n\\r\\n`) is reached, or `{:error, reason}`.
  """
  def recv_chunked(socket) do
    with {:ok, size_line} <- read_line(socket),
         {size, _} <- Integer.parse(String.trim_trailing(size_line, "\r\n"), 16) do
      cond do
        size == 0 ->
          # Final chunk — eat the trailing \r\n and signal end.
          _ = :gen_tcp.recv(socket, 2, 5_000)
          :eof

        size > 0 ->
          with {:ok, data} <- :gen_tcp.recv(socket, size, 60_000),
               {:ok, _crlf} <- :gen_tcp.recv(socket, 2, 60_000) do
            {:ok, data}
          end

        true ->
          {:error, :bad_chunk_size}
      end
    else
      :error -> {:error, :bad_chunk_size}
      err -> err
    end
  end

  defp read_line(socket, acc \\ "") do
    case :gen_tcp.recv(socket, 1, 60_000) do
      {:ok, byte} ->
        new_acc = acc <> byte

        if String.ends_with?(new_acc, "\r\n") do
          {:ok, new_acc}
        else
          read_line(socket, new_acc)
        end

      err ->
        err
    end
  end

  defp skip_http_headers(conn), do: skip_http_headers(conn, "")

  defp skip_http_headers(conn, acc) do
    case :gen_tcp.recv(conn, 1, 10_000) do
      {:ok, byte} ->
        new_acc = acc <> byte

        if String.ends_with?(new_acc, "\r\n\r\n") do
          :ok
        else
          skip_http_headers(conn, new_acc)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # Exec operations

  def exec_create(container_id, cmd, opts \\ []) do
    user = Keyword.get(opts, :user, "")
    attach_stdin = Keyword.get(opts, :stdin, false)
    env_list = Keyword.get(opts, :env, [])

    spec = %{
      "AttachStdout" => true,
      "AttachStderr" => true,
      "AttachStdin" => attach_stdin,
      "Cmd" => cmd
    }

    spec = if user != "", do: Map.put(spec, "User", user), else: spec
    spec = if env_list != [], do: Map.put(spec, "Env", env_list), else: spec

    {status, body} =
      rest("POST", "/containers/#{container_id}/exec", spec, [], operation: :exec_create)

    case ok_json(status, body) do
      {:ok, %{"Id" => exec_id}} -> {:ok, exec_id}
      {:ok, other} -> {:error, other}
      err -> err
    end
  end

  def exec_start(exec_id, opts \\ []) do
    timeout_ms = Keyword.get(opts, :timeout_ms, 30_000)

    conn =
      stream_start("POST", "/exec/#{exec_id}/start", %{"Detach" => false, "Tty" => false}, [],
        operation: :exec_start
      )
    skip_http_headers(conn)
    output = read_all_with_timeout(conn, timeout_ms)
    :gen_tcp.close(conn)
    {:ok, output}
  end

  defp read_all_with_timeout(conn, timeout_ms), do: read_all_with_timeout(conn, timeout_ms, "")

  defp read_all_with_timeout(conn, timeout_ms, acc) do
    case :gen_tcp.recv(conn, 0, timeout_ms) do
      {:ok, data} -> read_all_with_timeout(conn, timeout_ms, acc <> strip_docker_frame(data))
      {:error, _} -> acc
    end
  end

  defp strip_docker_frame(<<_type, 0, 0, 0, size::32-big, rest::binary>>)
       when byte_size(rest) >= size do
    <<payload::binary-size(size), remainder::binary>> = rest
    payload <> strip_docker_frame(remainder)
  end

  defp strip_docker_frame(data), do: data

  def resize_container(id, cols, rows) do
    {_status, _body} =
      rest("POST", "/containers/#{id}/resize?w=#{cols}&h=#{rows}", nil, [],
        operation: :resize_container
      )

    :ok
  end

  # Image operations

  def list_images do
    {status, body} = rest("GET", "/images/json", nil, [], operation: :list_images)
    ok_json(status, body)
  end

  def list_containers(opts \\ []) do
    all = if Keyword.get(opts, :all, false), do: "1", else: "0"
    {status, body} = rest("GET", "/containers/json?all=#{all}", nil, [], operation: :list_containers)
    ok_json(status, body)
  end

  def remove_image(tag, opts \\ []) do
    force = if Keyword.get(opts, :force, false), do: "1", else: "0"

    {status, body} =
      rest("DELETE", "/images/#{URI.encode(tag, &URI.char_unreserved?/1)}?force=#{force}", nil, [],
        operation: :remove_image
      )

    ok_unit(status, body)
  end

  def build_image(tar_binary, tag, on_chunk) do
    conn = connect!()
    len = byte_size(tar_binary)

    # Connection: close so Docker shuts the socket as soon as the response
    # body is complete. Without it, Docker keeps the keepalive socket open
    # past the final "Successfully tagged …" line and we'd block waiting
    # for an EOF that never comes — see comment in stream_build_output.
    req =
      "POST /build?t=#{URI.encode(tag, &URI.char_unreserved?/1)}&rm=1 HTTP/1.1\r\n" <>
        "Host: docker\r\n" <>
        "Content-Type: application/x-tar\r\n" <>
        "Content-Length: #{len}\r\n" <>
        "Connection: close\r\n" <>
        "\r\n"

    :ok = :gen_tcp.send(conn, req)
    :ok = :gen_tcp.send(conn, tar_binary)
    skip_http_headers(conn)
    result = stream_build_output(conn, on_chunk)
    :gen_tcp.close(conn)
    result
  end

  # Read the streaming /build response until Docker closes the socket. We
  # MUST NOT bail early on `{"aux":{"ID":...}}` or even on
  # `Successfully built …`: Docker emits both BEFORE applying the `t=` tag
  # to the resulting image. The tag is only finalized by the time
  # `Successfully tagged …` is sent (or shortly after), so closing the
  # client side any earlier races the tagging step and leaves the image
  # untagged — which manifests downstream as `create_container` 404'ing
  # with "No such image: <tag>". With `Connection: close` on the request
  # Docker drops the socket promptly after the response, so waiting for
  # `:closed` is cheap.
  defp stream_build_output(conn, on_chunk) do
    case :gen_tcp.recv(conn, 0, :infinity) do
      {:ok, data} ->
        for line <- String.split(data, "\n"), line != "" do
          case Jason.decode(line) do
            {:ok, %{"stream" => text}} ->
              on_chunk.(text)

            {:ok, %{"error" => err}} ->
              throw({:build_error, err})

            _ ->
              :ok
          end
        end

        stream_build_output(conn, on_chunk)

      {:error, :closed} ->
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  catch
    {:build_error, err} ->
      {:error, err}
  end

  @doc """
  Inject files into a container at `target_dir`. Uses Docker's PUT /archive
  endpoint, which works on stopped containers (unlike exec). The `uid`
  parameter is accepted for API parity with the previous exec-based version
  but is currently ignored — ownership is set in the tar headers themselves
  by `FBI.Orchestrator.Tar`.
  """
  def inject_files(container_id, target_dir, files, _uid \\ nil) do
    tar = FBI.Orchestrator.Tar.build(files)
    put_archive(container_id, target_dir, tar)
  end

  @doc "Upload a tar archive into a container at `path`. Works on stopped containers."
  def put_archive(container_id, path, tar_binary) do
    encoded_path = URI.encode(path, &URI.char_unreserved?/1)
    len = byte_size(tar_binary)

    conn = connect!()

    req =
      "PUT /containers/#{container_id}/archive?path=#{encoded_path} HTTP/1.1\r\n" <>
        "Host: docker\r\n" <>
        "Content-Type: application/x-tar\r\n" <>
        "Content-Length: #{len}\r\n" <>
        "Connection: close\r\n" <>
        "\r\n"

    :ok = :gen_tcp.send(conn, req)
    :ok = :gen_tcp.send(conn, tar_binary)
    {status, body} = recv_until_close(conn, "")
    :gen_tcp.close(conn)

    if status in 200..299 do
      :ok
    else
      raise "put_archive failed: #{status} #{body}"
    end
  end

  # Legacy exec-based path retained for callers that still need it (e.g., chown
  # in already-running containers). Not used by inject_files anymore.
  def inject_files_via_exec(container_id, target_dir, files, uid) do
    tar = FBI.Orchestrator.Tar.build(files)

    {:ok, exec_id} =
      exec_create(container_id, ["tar", "x", "-C", target_dir],
        user: if(uid, do: "0", else: ""),
        stdin: true
      )

    conn =
      stream_start("POST", "/exec/#{exec_id}/start", %{"Detach" => false, "Tty" => false}, [],
        operation: :exec_start_inject
      )

    skip_http_headers(conn)
    :gen_tcp.send(conn, tar)
    :gen_tcp.close(conn)

    if uid do
      paths = Map.keys(files) |> Enum.map(fn p -> "#{target_dir}/#{p}" end)
      {:ok, chown_id} = exec_create(container_id, ["chown", "#{uid}:#{uid}" | paths], user: "0")
      exec_start(chown_id)
    end

    :ok
  end

  def inspect_exec(exec_id) do
    {status, body} = rest("GET", "/exec/#{exec_id}/json", nil, [], operation: :inspect_exec)
    ok_json(status, body)
  end

  def stream_exec_with_stdin(exec_id, stdin_data) do
    conn =
      stream_start("POST", "/exec/#{exec_id}/start", %{"Detach" => false, "Tty" => false}, [],
        operation: :stream_exec_with_stdin
      )

    skip_http_headers(conn)
    :gen_tcp.send(conn, stdin_data)
    conn
  end

  def close_socket(conn), do: :gen_tcp.close(conn)
end
