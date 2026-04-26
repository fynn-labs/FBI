defmodule FBIWeb.QuanticoController do
  use FBIWeb, :controller

  def index(conn, _params) do
    if Application.get_env(:fbi, :quantico_enabled, false) do
      names = Application.get_env(:fbi, :quantico_scenarios, MapSet.new()) |> MapSet.to_list()
      json(conn, %{scenarios: names})
    else
      conn |> put_status(404) |> json(%{error: "not_found"})
    end
  end
end
