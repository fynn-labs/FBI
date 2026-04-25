defmodule FBI.Orchestrator.UsageTailer do
  @moduledoc "Port of src/server/orchestrator/usageTailer.ts."
  use GenServer

  defstruct [:dir, :poll_ms, :on_usage, :on_rate_limit, :on_error, :offsets, :pending, :timer]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def stop(pid), do: GenServer.stop(pid)

  @impl true
  def init(opts) do
    state = %__MODULE__{
      dir: Keyword.fetch!(opts, :dir),
      poll_ms: Keyword.get(opts, :poll_ms, 500),
      on_usage: Keyword.fetch!(opts, :on_usage),
      on_rate_limit: Keyword.fetch!(opts, :on_rate_limit),
      on_error: Keyword.fetch!(opts, :on_error),
      offsets: %{},
      pending: %{},
      timer: nil
    }

    {:ok, schedule(state)}
  end

  @impl true
  def handle_info(:tick, state) do
    state = scan_and_read(state)
    {:noreply, schedule(state)}
  end

  @impl true
  def terminate(_reason, state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    scan_and_read(state)
    :ok
  end

  defp schedule(state) do
    timer = Process.send_after(self(), :tick, state.poll_ms)
    %{state | timer: timer}
  end

  defp scan_and_read(state) do
    files = find_jsonl_files(state.dir)
    Enum.reduce(files, state, &read_new_lines/2)
  end

  defp find_jsonl_files(dir) do
    case File.ls(dir) do
      {:error, _} ->
        []

      {:ok, entries} ->
        Enum.flat_map(entries, fn e ->
          path = Path.join(dir, e)

          case File.stat(path) do
            {:ok, %{type: :directory}} -> find_jsonl_files(path)
            {:ok, %{type: :regular}} -> if String.ends_with?(e, ".jsonl"), do: [path], else: []
            _ -> []
          end
        end)
    end
  end

  defp read_new_lines(file, state) do
    case File.stat(file) do
      {:error, _} ->
        state

      {:ok, %{size: size}} ->
        last_offset = Map.get(state.offsets, file, 0)

        if size <= last_offset do
          state
        else
          case :file.open(file, [:read, :binary]) do
            {:error, _} ->
              state

            {:ok, fd} ->
              {:ok, _} = :file.position(fd, last_offset)
              {:ok, data} = :file.read(fd, size - last_offset)
              :file.close(fd)
              prior = Map.get(state.pending, file, "")
              chunk = prior <> data
              {complete, partial} = split_at_last_newline(chunk)

              state = %{
                state
                | offsets: Map.put(state.offsets, file, size),
                  pending: Map.put(state.pending, file, partial)
              }

              Enum.reduce(String.split(complete, "\n"), state, fn line, s ->
                process_line(String.trim(line), s)
              end)
          end
        end
    end
  end

  defp split_at_last_newline(chunk) do
    case :binary.matches(chunk, "\n") do
      [] ->
        {"", chunk}

      matches ->
        {last_pos, _} = List.last(matches)
        complete = binary_part(chunk, 0, last_pos)
        partial = binary_part(chunk, last_pos + 1, byte_size(chunk) - last_pos - 1)
        {complete, partial}
    end
  end

  defp process_line("", state), do: state

  defp process_line(line, state) do
    case parse_usage_line(line) do
      {:ok, snapshot} -> state.on_usage.(snapshot)
      {:error, _reason} -> :ok
    end

    case Jason.decode(line) do
      {:ok, obj} ->
        case parse_rate_limit(obj) do
          {:ok, snapshot} -> state.on_rate_limit.(snapshot)
          _ -> :ok
        end

      _ ->
        :ok
    end

    state
  end

  defp parse_usage_line(line) do
    case Jason.decode(line) do
      {:ok, %{"type" => "assistant", "message" => %{"usage" => usage}}} ->
        {:ok,
         %{
           input_tokens: usage["input_tokens"] || 0,
           output_tokens: usage["output_tokens"] || 0,
           cache_creation_input_tokens: usage["cache_creation_input_tokens"] || 0,
           cache_read_input_tokens: usage["cache_read_input_tokens"] || 0
         }}

      {:ok, _} ->
        {:error, :not_usage}

      {:error, _} ->
        {:error, :parse_error}
    end
  end

  defp parse_rate_limit(%{
         "x-ratelimit-requests-remaining" => rr,
         "x-ratelimit-requests-limit" => rl
       }) do
    {:ok,
     %{
       requests_remaining: to_int(rr),
       requests_limit: to_int(rl),
       tokens_remaining: nil,
       tokens_limit: nil,
       reset_at: nil
     }}
  end

  defp parse_rate_limit(_), do: :error

  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_binary(v), do: String.to_integer(v)
  defp to_int(_), do: nil
end
