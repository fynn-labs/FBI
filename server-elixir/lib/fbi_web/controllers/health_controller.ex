defmodule FBIWeb.HealthController do
  @moduledoc "GET /api/health — fixed `{\"ok\": true}` response."
  use FBIWeb, :controller

  def show(conn, _params), do: json(conn, %{ok: true})
end
