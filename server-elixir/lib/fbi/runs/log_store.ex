defmodule FBI.Runs.LogStore do
  @moduledoc "Reads run transcript files. Empty binary when missing, per TS contract."

  @spec read_all(Path.t()) :: binary()
  def read_all(path) do
    case File.read(path) do
      {:ok, data} -> data
      {:error, _} -> <<>>
    end
  end
end
