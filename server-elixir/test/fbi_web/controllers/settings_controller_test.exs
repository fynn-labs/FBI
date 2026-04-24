defmodule FBIWeb.SettingsControllerTest do
  @moduledoc """
  Mirrors the vitest cases in `src/server/api/settings.test.ts` so the byte
  contract (keys, types, status codes) matches what the React UI already
  uses against TS.
  """

  # async: false — the singleton settings row is shared state.
  use FBIWeb.ConnCase, async: false

  describe "GET /api/settings" do
    test "returns defaults including auto_resume fields", %{conn: conn} do
      conn = get(conn, "/api/settings")
      assert conn.status == 200

      body = json_response(conn, 200)
      assert is_boolean(body["auto_resume_enabled"])
      assert is_integer(body["auto_resume_max_attempts"])
      assert is_boolean(body["notifications_enabled"])
      assert is_boolean(body["image_gc_enabled"])
      assert is_boolean(body["usage_notifications_enabled"])
      assert body["global_marketplaces"] == []
      assert body["global_plugins"] == []
    end

    test "response includes every documented key", %{conn: conn} do
      body = conn |> get("/api/settings") |> json_response(200)

      expected_keys = ~w(
        global_prompt notifications_enabled concurrency_warn_at
        image_gc_enabled last_gc_at last_gc_count last_gc_bytes
        global_marketplaces global_plugins
        auto_resume_enabled auto_resume_max_attempts
        usage_notifications_enabled updated_at
      )

      assert Enum.sort(Map.keys(body)) == Enum.sort(expected_keys)
    end
  end

  describe "PATCH /api/settings" do
    test "rejects out-of-range auto_resume_max_attempts (0)", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{auto_resume_max_attempts: 0}))

      assert conn.status == 400

      assert json_response(conn, 400) == %{
               "error" => "auto_resume_max_attempts must be an integer between 1 and 20"
             }
    end

    test "rejects out-of-range auto_resume_max_attempts (21)", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{auto_resume_max_attempts: 21}))

      assert conn.status == 400
    end

    test "updates auto_resume_enabled and auto_resume_max_attempts", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/api/settings",
          Jason.encode!(%{auto_resume_enabled: true, auto_resume_max_attempts: 7})
        )

      assert conn.status == 200
      body = json_response(conn, 200)
      assert body["auto_resume_enabled"] == true
      assert body["auto_resume_max_attempts"] == 7
    end

    test "PATCH then GET round-trips usage_notifications_enabled", %{conn: conn} do
      patch_conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{usage_notifications_enabled: true}))

      assert patch_conn.status == 200
      assert json_response(patch_conn, 200)["usage_notifications_enabled"] == true

      get_conn = get(build_conn(), "/api/settings")
      assert json_response(get_conn, 200)["usage_notifications_enabled"] == true
    end

    test "updates global_marketplaces and global_plugins as list fields", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/api/settings",
          Jason.encode!(%{
            global_marketplaces: ["foo", "bar"],
            global_plugins: ["baz"]
          })
        )

      assert conn.status == 200
      body = json_response(conn, 200)
      assert body["global_marketplaces"] == ["foo", "bar"]
      assert body["global_plugins"] == ["baz"]
    end

    test "updated_at is monotonically non-decreasing across PATCHes", %{conn: conn} do
      a =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{global_prompt: "a"}))
        |> json_response(200)

      :timer.sleep(2)

      b =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{global_prompt: "b"}))
        |> json_response(200)

      assert b["updated_at"] > a["updated_at"]
    end
  end
end
