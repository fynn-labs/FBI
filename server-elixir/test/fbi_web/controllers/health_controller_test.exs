defmodule FBIWeb.HealthControllerTest do
  use FBIWeb.ConnCase, async: true

  test "GET /api/health returns {ok: true}", %{conn: conn} do
    assert conn |> get("/api/health") |> json_response(200) == %{"ok" => true}
  end
end
