defmodule FBI.Uploads.FS do
  @moduledoc """
  Filename-safety helpers for upload routes.

  Rules match TS `src/server/api/uploads.ts`:
    - No `/`, `\\`, or NULL bytes
    - Not `.`, `..`, or starts with `..`
    - Max 255 bytes (UTF-8)
    - Deduplicate conflicts with ` (1)`, ` (2)`, ... up to 9999
  """

  @max_bytes 255

  @spec sanitize_filename(any()) :: {:ok, String.t()} | {:error, :invalid}
  def sanitize_filename(s) when is_binary(s) do
    trimmed = String.trim(s)

    cond do
      trimmed == "" -> {:error, :invalid}
      trimmed == "." -> {:error, :invalid}
      trimmed == ".." -> {:error, :invalid}
      String.starts_with?(trimmed, "..") -> {:error, :invalid}
      Regex.match?(~r<[/\\\x00]>, trimmed) -> {:error, :invalid}
      byte_size(trimmed) > @max_bytes -> {:error, :invalid}
      true -> {:ok, trimmed}
    end
  end

  def sanitize_filename(_), do: {:error, :invalid}

  @spec resolve_filename(Path.t(), String.t()) ::
          {:ok, String.t()} | {:error, :collision_overflow}
  def resolve_filename(dir, filename) do
    path = Path.join(dir, filename)

    if File.exists?(path) do
      {stem, ext} = split_ext(filename)
      try_variants(dir, stem, ext, 1)
    else
      {:ok, filename}
    end
  end

  defp try_variants(_dir, _stem, _ext, n) when n > 9999, do: {:error, :collision_overflow}

  defp try_variants(dir, stem, ext, n) do
    candidate = "#{stem} (#{n})#{ext}"

    if File.exists?(Path.join(dir, candidate)) do
      try_variants(dir, stem, ext, n + 1)
    else
      {:ok, candidate}
    end
  end

  defp split_ext(filename) do
    ext = Path.extname(filename)
    stem = Path.basename(filename, ext)
    {stem, ext}
  end

  @spec directory_bytes(Path.t()) :: non_neg_integer()
  def directory_bytes(dir) do
    case File.ls(dir) do
      {:ok, entries} ->
        entries
        |> Enum.reduce(0, fn name, acc ->
          case File.stat(Path.join(dir, name)) do
            {:ok, %File.Stat{type: :regular, size: sz}} -> acc + sz
            _ -> acc
          end
        end)

      {:error, _} ->
        0
    end
  end

  @spec draft_token() :: String.t()
  def draft_token do
    :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower)
  end

  @spec valid_draft_token?(String.t()) :: boolean()
  def valid_draft_token?(s) when is_binary(s), do: Regex.match?(~r/^[0-9a-f]{32}$/, s)
  def valid_draft_token?(_), do: false
end
