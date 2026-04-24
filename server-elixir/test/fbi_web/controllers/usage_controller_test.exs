defmodule FBIWeb.UsageControllerTest do
  use FBIWeb.ConnCase, async: true

  alias FBI.Repo
  alias FBI.Usage.Queries
  alias FBI.Usage.RunUsageEvent

  defp insert_event(attrs) do
    Repo.insert!(%RunUsageEvent{
      run_id: attrs[:run_id] || 1,
      ts: attrs[:ts],
      model: attrs[:model] || "claude-opus-4-5",
      input_tokens: attrs[:input_tokens] || 0,
      output_tokens: attrs[:output_tokens] || 0,
      cache_read_tokens: attrs[:cache_read_tokens] || 0,
      cache_create_tokens: attrs[:cache_create_tokens] || 0
    })
  end

  # ---------------------------------------------------------------------------
  # GET /api/usage
  # ---------------------------------------------------------------------------

  describe "show/2" do
    test "returns 200 with snapshot shape", %{conn: conn} do
      conn = get(conn, "/api/usage")
      assert conn.status == 200

      body = json_response(conn, 200)
      assert Map.has_key?(body, "plan")
      assert Map.has_key?(body, "observed_at")
      assert Map.has_key?(body, "last_error")
      assert Map.has_key?(body, "last_error_at")
      assert Map.has_key?(body, "buckets")
      assert Map.has_key?(body, "pacing")
    end

    test "snapshot buckets is a list", %{conn: conn} do
      body = json_response(get(conn, "/api/usage"), 200)
      assert is_list(body["buckets"])
    end

    test "snapshot pacing is a map", %{conn: conn} do
      body = json_response(get(conn, "/api/usage"), 200)
      assert is_map(body["pacing"])
    end

    test "snapshot reflects seeded plan", %{conn: conn} do
      Queries.set_plan("pro")
      body = json_response(get(conn, "/api/usage"), 200)
      assert body["plan"] == "pro"
    end
  end

  # ---------------------------------------------------------------------------
  # GET /api/usage/daily
  # ---------------------------------------------------------------------------

  describe "daily/2" do
    test "returns 200 with list of daily aggregates", %{conn: conn} do
      # Use timestamps relative to now so the 14-day window includes them.
      now_ms = System.system_time(:millisecond)
      day1_ts = now_ms - 2 * 24 * 60 * 60 * 1000
      day2_ts = now_ms - 1 * 24 * 60 * 60 * 1000
      insert_event(%{ts: day1_ts, run_id: 1, input_tokens: 100, output_tokens: 50})
      insert_event(%{ts: day2_ts, run_id: 2, input_tokens: 200, output_tokens: 80})

      conn = get(conn, "/api/usage/daily?days=14")
      assert conn.status == 200

      rows = json_response(conn, 200)
      assert is_list(rows)
      assert length(rows) == 2

      [d1 | _] = rows
      assert Map.has_key?(d1, "date")
      assert Map.has_key?(d1, "tokens_total")
      assert Map.has_key?(d1, "tokens_input")
      assert Map.has_key?(d1, "tokens_output")
      assert Map.has_key?(d1, "tokens_cache_read")
      assert Map.has_key?(d1, "tokens_cache_create")
      assert Map.has_key?(d1, "run_count")
    end

    test "defaults to 14 days when ?days is omitted", %{conn: conn} do
      # Insert an event well within 14 days from now
      now_ms = System.system_time(:millisecond)
      recent_ts = now_ms - 3 * 24 * 60 * 60 * 1000
      insert_event(%{ts: recent_ts, run_id: 1, input_tokens: 10, output_tokens: 5})

      rows = json_response(get(conn, "/api/usage/daily"), 200)
      assert is_list(rows)
      assert length(rows) >= 1
    end

    test "excludes event older than 14 days when no days param", %{conn: conn} do
      # Event more than 14 days ago — should be excluded by the 14-day default
      old_ts = System.system_time(:millisecond) - 20 * 24 * 60 * 60 * 1000
      insert_event(%{ts: old_ts, run_id: 99, input_tokens: 999, output_tokens: 999})

      rows = json_response(get(conn, "/api/usage/daily"), 200)
      # The old event falls outside the 14-day window; all returned dates must
      # be within the last 14 days.
      for row <- rows do
        cutoff = Date.add(Date.utc_today(), -14) |> Date.to_string()
        assert row["date"] >= cutoff
      end
    end

    test "falls back to 14 days when ?days=foo (non-integer)", %{conn: conn} do
      # Should not crash; just return a list (empty is fine)
      conn = get(conn, "/api/usage/daily?days=foo")
      assert conn.status == 200
      assert is_list(json_response(conn, 200))
    end

    test "accepts numeric days param", %{conn: conn} do
      # Insert an event 3 days ago, request with days=7
      now_ms = System.system_time(:millisecond)
      ts = now_ms - 3 * 24 * 60 * 60 * 1000
      insert_event(%{ts: ts, run_id: 1, input_tokens: 50, output_tokens: 25})

      rows = json_response(get(conn, "/api/usage/daily?days=7"), 200)
      assert is_list(rows)
      assert length(rows) >= 1
    end
  end

  # ---------------------------------------------------------------------------
  # GET /api/usage/runs/:id
  # ---------------------------------------------------------------------------

  describe "run_breakdown/2" do
    test "returns 200 with per-model breakdown for valid run id", %{conn: conn} do
      Repo.insert!(%RunUsageEvent{
        run_id: 42,
        ts: 1_700_000_000_000,
        model: "claude-opus-4-5",
        input_tokens: 100,
        output_tokens: 200,
        cache_read_tokens: 30,
        cache_create_tokens: 40
      })

      conn = get(conn, "/api/usage/runs/42")
      assert conn.status == 200

      [row] = json_response(conn, 200)
      assert Map.has_key?(row, "model")
      assert Map.has_key?(row, "input")
      assert Map.has_key?(row, "output")
      assert Map.has_key?(row, "cache_read")
      assert Map.has_key?(row, "cache_create")

      assert row["model"] == "claude-opus-4-5"
      assert row["input"] == 100
      assert row["output"] == 200
      assert row["cache_read"] == 30
      assert row["cache_create"] == 40
    end

    test "returns empty list when run has no events", %{conn: conn} do
      conn = get(conn, "/api/usage/runs/9999")
      assert conn.status == 200
      assert json_response(conn, 200) == []
    end

    test "returns 400 with error body for non-integer id", %{conn: conn} do
      conn = get(conn, "/api/usage/runs/abc")
      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "invalid id"}
    end

    test "returns 400 for id with trailing non-digit chars", %{conn: conn} do
      conn = get(conn, "/api/usage/runs/42abc")
      assert conn.status == 400
      assert json_response(conn, 400) == %{"error" => "invalid id"}
    end

    test "aggregates multiple events per model", %{conn: conn} do
      for _ <- 1..3 do
        Repo.insert!(%RunUsageEvent{
          run_id: 7,
          ts: 1_700_000_000_000,
          model: "claude-sonnet-4-6",
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 5,
          cache_create_tokens: 2
        })
      end

      [row] = json_response(get(conn, "/api/usage/runs/7"), 200)
      assert row["input"] == 30
      assert row["output"] == 60
      assert row["cache_read"] == 15
      assert row["cache_create"] == 6
    end
  end
end
