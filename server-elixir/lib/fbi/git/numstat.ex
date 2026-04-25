defmodule FBI.Git.Numstat do
  @moduledoc """
  Parses `git show --numstat --format=` and `git diff --numstat` output.

  Each line is `<additions>\t<deletions>\t<path>`. For binary files git prints
  `-\t-\t<path>`. Status (`A`/`D`/`M`) is inferred since numstat doesn't
  surface git's status code directly: `-`/`-` always `M` (binary edit);
  `0`/`N>0` → `D`; `N>0`/`0` → `A`; otherwise `M`. Renames (`R`) cannot be
  inferred from numstat alone — git would emit them under a `--name-status`
  flag instead, which we don't use here.
  """

  @type entry :: %{
          path: String.t(),
          status: String.t(),
          additions: non_neg_integer(),
          deletions: non_neg_integer()
        }

  @spec parse(binary()) :: [entry()]
  def parse(text) when is_binary(text) do
    text
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case String.split(line, "\t", parts: 3) do
        [add, del, path] -> [build(add, del, path)]
        _ -> []
      end
    end)
  end

  defp build(add_raw, del_raw, path) do
    add = parse_int(add_raw)
    del = parse_int(del_raw)
    %{path: path, status: status(add_raw, del_raw, add, del), additions: add, deletions: del}
  end

  defp status("-", "-", _, _), do: "M"
  defp status(_, _, 0, 0), do: "M"
  defp status(_, _, 0, _), do: "D"
  defp status(_, _, _, 0), do: "A"
  defp status(_, _, _, _), do: "M"

  defp parse_int("-"), do: 0

  defp parse_int(s) do
    case Integer.parse(s) do
      {n, _} -> n
      :error -> 0
    end
  end
end
