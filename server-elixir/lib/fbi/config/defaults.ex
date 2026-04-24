defmodule FBI.Config.Defaults do
  @moduledoc """
  Server-side defaults for marketplaces and plugins, sourced from environment
  variables.  Mirrors `legacyDefaultLists/0` in `src/server/config.ts`.

  This is a plain module (no process state) — the data is derived fresh each
  call from env vars so that operators can re-export and restart without a
  cache to invalidate.  The cost is negligible (two `System.get_env` reads).

  Why it exists: the React frontend hits `GET /api/config/defaults` to show
  the user what upstream marketplaces/plugins are bundled with the server.
  The same lists are also used by TS's startup migration, which is why the
  TS side calls it "legacy" — the Elixir port does not need to mark it so
  because Elixir does not yet own startup migrations.
  """

  @type list_result :: %{marketplaces: [String.t()], plugins: [String.t()]}

  @doc """
  Reads both env vars and returns a map with parsed lists.
  """
  @spec list() :: list_result()
  def list do
    %{
      marketplaces: parse(System.get_env("FBI_DEFAULT_MARKETPLACES")),
      plugins: parse(System.get_env("FBI_DEFAULT_PLUGINS"))
    }
  end

  # Parses an env-var value the same way TS's `parseList/1` does:
  # split on comma OR newline, trim each element, drop empties.
  # Keeping the empty-string case explicit avoids a regex split on `""`
  # that would return `[""]` and require a filter.
  defp parse(nil), do: []
  defp parse(""), do: []

  defp parse(value) when is_binary(value) do
    value
    |> String.split(~r/[,\n]/)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end
end
