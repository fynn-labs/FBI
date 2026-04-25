defmodule FBI.Runs.LogStore do
  @moduledoc """
  Low-level run transcript file helpers.

  A `LogStore` is an open file descriptor (an opaque reference) obtained
  via `open/1`. Bytes are appended with `append/2` and the handle is closed
  with `close/1`. Read-only helpers (`read_all/1`, `byte_size/1`,
  `read_range/3`) accept a plain file path and have no open-handle requirement.

  This module is intentionally stateless beyond the file descriptor — it does
  not hold a GenServer, buffer in memory, or do anything clever. Each active
  run opens one handle; the orchestrator closes it when the run terminates.
  """

  @opaque t :: %{fd: :file.fd(), path: Path.t()}

  @doc "Open `path` for appending, creating parent directories as needed."
  @spec open(Path.t()) :: t()
  def open(path) do
    path |> Path.dirname() |> File.mkdir_p!()
    {:ok, fd} = :file.open(path, [:append, :raw, :binary])
    %{fd: fd, path: path}
  end

  @doc "Append `data` (binary) to an open LogStore handle."
  @spec append(t(), binary()) :: :ok
  def append(%{fd: fd}, data) when is_binary(data) do
    :ok = :file.write(fd, data)
  end

  @doc "Close the file handle."
  @spec close(t()) :: :ok
  def close(%{fd: fd}) do
    :file.close(fd)
    :ok
  end

  @doc "Return total byte size of `path`, or 0 if the file is missing."
  @spec byte_size(Path.t()) :: non_neg_integer()
  def byte_size(path) do
    case File.stat(path) do
      {:ok, %{size: s}} -> s
      {:error, _} -> 0
    end
  end

  @doc """
  Read all bytes from `path`. Returns an empty binary if the file is missing.
  """
  @spec read_all(Path.t()) :: binary()
  def read_all(path) do
    case File.read(path) do
      {:ok, data} -> data
      {:error, _} -> ""
    end
  end

  @doc """
  Read the byte range `[start_byte, end_byte]` (both inclusive).
  Returns an empty binary for a missing file or when `start_byte >= file_size`.
  """
  @spec read_range(Path.t(), non_neg_integer(), non_neg_integer()) :: binary()
  def read_range(path, start_byte, end_byte) when start_byte <= end_byte do
    case :file.open(path, [:read, :raw, :binary]) do
      {:error, _} ->
        ""

      {:ok, fd} ->
        try do
          size =
            case :file.position(fd, :eof) do
              {:ok, s} -> s
              _ -> 0
            end

          if start_byte >= size do
            ""
          else
            clamped_end = min(end_byte, size - 1)
            length = clamped_end - start_byte + 1

            case :file.position(fd, start_byte) do
              {:ok, _} ->
                case :file.read(fd, length) do
                  {:ok, data} -> data
                  _ -> ""
                end

              _ ->
                ""
            end
          end
        after
          :file.close(fd)
        end
    end
  end
end
