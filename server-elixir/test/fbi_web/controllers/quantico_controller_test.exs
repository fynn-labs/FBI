defmodule FBIWeb.QuanticoControllerTest do
  use FBIWeb.ConnCase

  test "404 when capability is off", %{conn: conn} do
    Application.put_env(:fbi, :quantico_enabled, false)
    conn = get(conn, ~p"/api/quantico/scenarios")
    assert response(conn, 404)
  end

  test "lists scenarios when on", %{conn: conn} do
    Application.put_env(:fbi, :quantico_enabled, true)
    Application.put_env(:fbi, :quantico_scenarios, MapSet.new(["default", "limit-breach"]))
    conn = get(conn, ~p"/api/quantico/scenarios")
    body = json_response(conn, 200)
    assert "default" in body["scenarios"]
    assert "limit-breach" in body["scenarios"]
  end
end
