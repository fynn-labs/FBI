defmodule FBI.Github.Repo do
  @moduledoc "Parses owner/name pairs out of GitHub repo URLs (ssh + https forms)."

  @spec parse(String.t() | nil) :: {:ok, String.t()} | :error
  def parse(url) when is_binary(url) do
    patterns = [
      ~r{git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$},
      ~r{https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$}
    ]

    Enum.find_value(patterns, :error, fn re ->
      case Regex.run(re, url) do
        [_, owner, name] -> {:ok, "#{owner}/#{name}"}
        _ -> false
      end
    end)
  end

  def parse(_), do: :error
end
