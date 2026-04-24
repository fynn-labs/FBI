defmodule FBIWeb.ConfigControllerTest do
  @moduledoc """
  Contract for `GET /api/config/defaults`: returns exactly two keys,
  `defaultMarketplaces` and `defaultPlugins`, each an array of strings
  derived from `FBI_DEFAULT_MARKETPLACES` / `FBI_DEFAULT_PLUGINS` env vars.
  Mirrors the shape in `src/server/api/config.ts`.
  """

  use FBIWeb.ConnCase, async: false

  setup do
    mp = System.get_env("FBI_DEFAULT_MARKETPLACES")
    pl = System.get_env("FBI_DEFAULT_PLUGINS")
    System.delete_env("FBI_DEFAULT_MARKETPLACES")
    System.delete_env("FBI_DEFAULT_PLUGINS")

    on_exit(fn ->
      if mp,
        do: System.put_env("FBI_DEFAULT_MARKETPLACES", mp),
        else: System.delete_env("FBI_DEFAULT_MARKETPLACES")

      if pl,
        do: System.put_env("FBI_DEFAULT_PLUGINS", pl),
        else: System.delete_env("FBI_DEFAULT_PLUGINS")
    end)

    :ok
  end

  test "returns empty lists when env vars are unset", %{conn: conn} do
    conn = get(conn, "/api/config/defaults")
    assert conn.status == 200
    assert json_response(conn, 200) == %{"defaultMarketplaces" => [], "defaultPlugins" => []}
  end

  test "returns parsed lists from env vars", %{conn: conn} do
    System.put_env("FBI_DEFAULT_MARKETPLACES", "foo,bar")
    System.put_env("FBI_DEFAULT_PLUGINS", "baz")

    body = conn |> get("/api/config/defaults") |> json_response(200)
    assert body == %{"defaultMarketplaces" => ["foo", "bar"], "defaultPlugins" => ["baz"]}
  end

  test "uses camelCase keys to match the TS contract", %{conn: conn} do
    body = conn |> get("/api/config/defaults") |> json_response(200)
    assert Enum.sort(Map.keys(body)) == ["defaultMarketplaces", "defaultPlugins"]
  end
end
