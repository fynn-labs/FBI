defmodule FBI.Runs.LogStore do
  @moduledoc "Reads run transcript files. Empty binary when missing, per TS contract."

  @spec byte_size(Path.t()) :: non_neg_integer()
  def byte_size(path) do
    case File.stat(path) do
      {:ok, %{size: size}} -> size
      {:error, _} -> 0
    end
  end

  @spec read_all(Path.t()) :: binary()
  def read_all(path) do
    case File.read(path) do
      {:ok, data} -> data
      {:error, _} -> <<>>
    end
  end

  @spec read_range(Path.t(), non_neg_integer(), non_neg_integer()) :: binary()
  def read_range(path, start_offset, end_offset) do
    length = end_offset - start_offset + 1

    case :file.open(path, [:read, :binary, :raw]) do
      {:ok, fd} ->
        data =
          case :file.pread(fd, start_offset, length) do
            {:ok, bytes} -> bytes
            _ -> <<>>
          end

        :file.close(fd)
        data

      {:error, _} ->
        <<>>
    end
  end
end
