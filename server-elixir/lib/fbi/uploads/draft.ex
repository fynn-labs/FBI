defmodule FBI.Uploads.Draft do
  @moduledoc "Move draft uploads from `<draft_dir>/<token>` into a run's uploads dir."

  alias FBI.Uploads.FS

  @token_re ~r/^[0-9a-f]{32}$/

  @spec valid_token?(term()) :: boolean()
  def valid_token?(v) when is_binary(v), do: Regex.match?(@token_re, v)
  def valid_token?(_), do: false

  @spec promote(Path.t(), Path.t(), String.t(), integer()) ::
          {:ok, [%{filename: String.t(), size: integer()}]} | {:error, term()}
  def promote(draft_dir, runs_dir, token, run_id) do
    src = Path.join(draft_dir, token)
    dst = Path.join([runs_dir, Integer.to_string(run_id), "uploads"])

    with {:ok, entries} <- File.ls(src),
         :ok <- File.mkdir_p(dst) do
      promoted =
        entries
        |> Enum.reject(&String.ends_with?(&1, ".part"))
        |> Enum.map(fn name ->
          {:ok, final} = FS.resolve_filename(dst, name)
          src_path = Path.join(src, name)
          dst_path = Path.join(dst, final)
          :ok = File.rename(src_path, dst_path)
          %File.Stat{size: size} = File.stat!(dst_path)
          %{filename: final, size: size}
        end)

      File.rm_rf(src)
      {:ok, promoted}
    end
  end
end
