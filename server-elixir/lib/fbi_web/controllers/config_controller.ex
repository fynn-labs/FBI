defmodule FBIWeb.ConfigController do
  @moduledoc """
  Exposes read-only server defaults to the UI.

  Currently serves one route:

  - `GET /api/config/defaults` — returns the default marketplaces and plugins
    derived from environment variables.

  Plain controller; no process or cache is needed because the values are
  read on demand from `FBI.Config.Defaults`.  Kept in its own module
  (rather than bolted onto `SettingsController`) to mirror the TS file
  layout and to keep the blast radius of future additions narrow.
  """

  use FBIWeb, :controller

  alias FBI.Config.Defaults

  @doc """
  GET /api/config/defaults — returns `%{defaultMarketplaces:, defaultPlugins:}`.

  The camelCase key names match the TS contract verbatim; the React UI
  depends on them.
  """
  def defaults(conn, _params) do
    lists = Defaults.list()

    json(conn, %{
      defaultMarketplaces: lists.marketplaces,
      defaultPlugins: lists.plugins
    })
  end
end
