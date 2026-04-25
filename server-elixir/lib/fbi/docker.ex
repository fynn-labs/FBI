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

  defp rest(method, path, body \\ nil, extra_headers \\ []) do
    conn = connect!()
    raw_body = if body, do: Jason.encode!(body), else: ""

    content_headers =
      if body != nil do
        [{"Content-Type", "application/json"}, {"Content-Length", byte_size(raw_body)}]
      else
        [{"Content-Length", "0"}]
      end

    headers = [{"Host", "docker"} | content_headers ++ extra_headers]
    header_str = Enum.map_join(headers, "\r\n", fn {k, v} -> "#{k}: #{v}" end)
    req = "#{method} #{path} HTTP/1.1\r\n#{header_str}\r\n\r\n#{raw_body}"
    :ok = :gen_tcp.send(conn, req)
    {status, resp_body} = recv_until_close(conn, "")
    :gen_tcp.close(conn)
    {status, resp_body}
  end

  defp stream_start(method, path, body \\ nil, extra_headers \\ []) do
    conn = connect!()
    raw_body = if body, do: Jason.encode!(body), else: ""

    content_headers =
      if body != nil do
        [{"Content-Type", "application/json"}, {"Content-Length", byte_size(raw_body)}]
      else
        [{"Content-Length", "0"}]
      end

    headers = [{"Host", "docker"} | content_headers ++ extra_headers]
    header_str = Enum.map_join(headers, "\r\n", fn {k, v} -> "#{k}: #{v}" end)
    req = "#{method} #{path} HTTP/1.1\r\n#{header_str}\r\n\r\n#{raw_body}"
    :ok = :gen_tcp.send(conn, req)
    conn
  end

  defp recv_until_close(conn, acc) do
    case :gen_tcp.recv(conn, 0, 60_000) do
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

  # Container operations

  def create_container(spec) do
    {status, body} = rest("POST", "/containers/create", spec)

    case ok_json(status, body) do
      {:ok, %{"Id" => id}} -> {:ok, id}
      {:ok, other} -> {:error, other}
      err -> err
    end
  end

  def start_container(id) do
    {status, body} = rest("POST", "/containers/#{id}/start")
    ok_unit(status, body)
  end

  def stop_container(id, opts \\ []) do
    t = Keyword.get(opts, :t, 10)
    {status, body} = rest("POST", "/containers/#{id}/stop?t=#{t}")
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
    {status, body} = rest("DELETE", "/containers/#{id}?force=#{force}&v=#{v}")
    ok_unit(status, body)
  end

  def inspect_container(id) do
    {status, body} = rest("GET", "/containers/#{id}/json")
    ok_json(status, body)
  end

  def wait_container(id) do
    conn = stream_start("POST", "/containers/#{id}/wait")
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
        [{"Upgrade", "tcp"}, {"Connection", "Upgrade"}]
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
        [{"Upgrade", "tcp"}, {"Connection", "Upgrade"}]
      )

    skip_http_headers(conn)
    {:ok, conn}
  end

  def container_logs(id, opts \\ []) do
    since = Keyword.get(opts, :since, 0)
    conn = stream_start("GET", "/containers/#{id}/logs?follow=1&stdout=1&stderr=1&since=#{since}")
    skip_http_headers(conn)
    {:ok, conn}
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
    {status, body} = rest("POST", "/containers/#{container_id}/exec", spec)

    case ok_json(status, body) do
      {:ok, %{"Id" => exec_id}} -> {:ok, exec_id}
      {:ok, other} -> {:error, other}
      err -> err
    end
  end

  def exec_start(exec_id, opts \\ []) do
    timeout_ms = Keyword.get(opts, :timeout_ms, 30_000)
    conn = stream_start("POST", "/exec/#{exec_id}/start", %{"Detach" => false, "Tty" => false})
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
    {_status, _body} = rest("POST", "/containers/#{id}/resize?w=#{cols}&h=#{rows}")
    :ok
  end

  # Image operations

  def list_images do
    {status, body} = rest("GET", "/images/json")
    ok_json(status, body)
  end

  def list_containers(opts \\ []) do
    all = if Keyword.get(opts, :all, false), do: "1", else: "0"
    {status, body} = rest("GET", "/containers/json?all=#{all}")
    ok_json(status, body)
  end

  def remove_image(tag, opts \\ []) do
    force = if Keyword.get(opts, :force, false), do: "1", else: "0"

    {status, body} =
      rest("DELETE", "/images/#{URI.encode(tag, &URI.char_unreserved?/1)}?force=#{force}")

    ok_unit(status, body)
  end

  def build_image(tar_binary, tag, on_chunk) do
    conn = connect!()
    len = byte_size(tar_binary)

    req =
      "POST /build?t=#{URI.encode(tag, &URI.char_unreserved?/1)}&rm=1 HTTP/1.1\r\n" <>
        "Host: docker\r\n" <>
        "Content-Type: application/x-tar\r\n" <>
        "Content-Length: #{len}\r\n" <>
        "\r\n"

    :ok = :gen_tcp.send(conn, req)
    :ok = :gen_tcp.send(conn, tar_binary)
    skip_http_headers(conn)
    result = stream_build_output(conn, on_chunk)
    :gen_tcp.close(conn)
    result
  end

  defp stream_build_output(conn, on_chunk) do
    case :gen_tcp.recv(conn, 0, 120_000) do
      {:ok, data} ->
        for line <- String.split(data, "\n"), line != "" do
          case Jason.decode(line) do
            {:ok, %{"stream" => text}} -> on_chunk.(text)
            {:ok, %{"error" => err}} -> throw({:build_error, err})
            _ -> :ok
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
      :gen_tcp.close(conn)
      {:error, err}
  end

  def inject_files(container_id, target_dir, files, uid \\ nil) do
    tar = FBI.Orchestrator.Tar.build(files)

    {:ok, exec_id} =
      exec_create(container_id, ["tar", "x", "-C", target_dir],
        user: if(uid, do: "0", else: ""),
        stdin: true
      )

    conn = stream_start("POST", "/exec/#{exec_id}/start", %{"Detach" => false, "Tty" => false})
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
    {status, body} = rest("GET", "/exec/#{exec_id}/json")
    ok_json(status, body)
  end

  def stream_exec_with_stdin(exec_id, stdin_data) do
    conn = stream_start("POST", "/exec/#{exec_id}/start", %{"Detach" => false, "Tty" => false})
    skip_http_headers(conn)
    :gen_tcp.send(conn, stdin_data)
    conn
  end

  def close_socket(conn), do: :gen_tcp.close(conn)
end
