defmodule FBI.Usage.OAuthClientTest do
  use ExUnit.Case, async: true

  alias FBI.Usage.OAuthClient

  # Helper to build a Plug stub that returns a fixed status + body map.
  defp stub_plug(status, body) do
    fn conn, _opts ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(status, Jason.encode!(body))
    end
  end

  # ---------------------------------------------------------------------------
  # fetch_usage/1
  # ---------------------------------------------------------------------------

  describe "fetch_usage/1 happy path (live shape)" do
    test "returns normalized buckets; applies alias, divides utilization, coerces timestamps" do
      # seven_day → weekly alias; utilization 75 → 0.75
      # resets_at as ISO-8601 string, window_started_at absent → derived
      reset_str = "2025-01-08T00:00:00Z"
      # 2025-01-08T00:00:00Z in ms
      reset_ms = 1_736_294_400_000

      body = %{
        "seven_day" => %{
          "utilization" => 75,
          "resets_at" => reset_str,
          "window_started_at" => nil
        }
      }

      {:ok, buckets} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      assert length(buckets) == 1
      [b] = buckets
      assert b.id == "weekly"
      assert_in_delta b.utilization, 0.75, 0.0001
      assert b.reset_at == reset_ms
      # weekly window = 7 * 24 * 3_600_000 = 604_800_000 ms
      assert b.window_started_at == reset_ms - 7 * 24 * 3_600_000
    end

    test "coerces numeric resets_at as seconds when < 1e12" do
      # 1_700_000_000 < 1e12 → treat as seconds → * 1000
      body = %{
        "five_hour" => %{
          "utilization" => 50,
          "resets_at" => 1_700_000_000,
          "window_started_at" => nil
        }
      }

      {:ok, buckets} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      [b] = buckets
      assert b.reset_at == 1_700_000_000 * 1000
      # five_hour window = 5 * 3_600_000 = 18_000_000 ms
      assert b.window_started_at == 1_700_000_000 * 1000 - 5 * 3_600_000
    end

    test "coerces numeric resets_at as ms when >= 1e12" do
      ms_val = 1_700_000_000_000

      body = %{
        "five_hour" => %{"utilization" => 50, "resets_at" => ms_val, "window_started_at" => nil}
      }

      {:ok, buckets} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      [b] = buckets
      assert b.reset_at == ms_val
    end

    test "coerces window_started_at as numeric seconds when present" do
      body = %{
        "five_hour" => %{
          "utilization" => 40,
          "resets_at" => 1_700_018_000,
          "window_started_at" => 1_700_000_000
        }
      }

      {:ok, buckets} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      [b] = buckets
      assert b.window_started_at == 1_700_000_000 * 1000
    end

    test "applies sonnet_weekly alias" do
      body = %{
        "seven_day_sonnet" => %{
          "utilization" => 30,
          "resets_at" => 1_700_000_000_001,
          "window_started_at" => nil
        }
      }

      {:ok, [b]} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      assert b.id == "sonnet_weekly"
    end

    test "clamps utilization > 100 to 1.0" do
      body = %{
        "five_hour" => %{
          "utilization" => 120,
          "resets_at" => 1_700_000_000_001,
          "window_started_at" => nil
        }
      }

      {:ok, [b]} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      assert b.utilization == 1.0
    end

    test "clamps negative utilization to 0.0" do
      body = %{
        "five_hour" => %{
          "utilization" => -10,
          "resets_at" => 1_700_000_000_001,
          "window_started_at" => nil
        }
      }

      {:ok, [b]} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      assert b.utilization == 0.0
    end
  end

  describe "fetch_usage/1 filtering" do
    test "skips extra_usage key" do
      body = %{
        "extra_usage" => %{"utilization" => 50, "resets_at" => 1_700_000_000_001},
        "five_hour" => %{
          "utilization" => 50,
          "resets_at" => 1_700_000_000_001,
          "window_started_at" => nil
        }
      }

      {:ok, buckets} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      ids = Enum.map(buckets, & &1.id)
      refute "extra_usage" in ids
      assert "five_hour" in ids
    end

    test "skips buckets with no resets_at" do
      body = %{
        "five_hour" => %{"utilization" => 50, "resets_at" => nil, "window_started_at" => nil},
        "weekly" => %{
          "utilization" => 30,
          "resets_at" => 1_700_000_000_001,
          "window_started_at" => nil
        }
      }

      {:ok, buckets} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      assert length(buckets) == 1
      assert hd(buckets).id == "weekly"
    end

    test "skips buckets where utilization is not a finite number" do
      body = %{
        "five_hour" => %{
          "utilization" => "not_a_number",
          "resets_at" => 1_700_000_000_001,
          "window_started_at" => nil
        },
        "weekly" => %{
          "utilization" => 40,
          "resets_at" => 1_700_000_000_001,
          "window_started_at" => nil
        }
      }

      {:ok, buckets} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      assert length(buckets) == 1
      assert hd(buckets).id == "weekly"
    end
  end

  describe "fetch_usage/1 legacy shape" do
    test "processes buckets array when present" do
      body = %{
        "buckets" => [
          %{"id" => "five_hour", "utilization" => 60, "resets_at" => 1_700_000_000_001},
          %{
            "id" => "seven_day",
            "utilization" => 80,
            "resets_at" => 1_700_000_000_001,
            "window_started_at" => nil
          }
        ]
      }

      {:ok, buckets} =
        OAuthClient.fetch_usage(token: "tok", req_opts: [plug: stub_plug(200, body)])

      ids = Enum.map(buckets, & &1.id)
      assert "five_hour" in ids
      # alias applied even in legacy shape
      assert "weekly" in ids
    end
  end

  describe "fetch_usage/1 error handling" do
    test "returns {:error, :expired} on 401" do
      {:error, :expired} =
        OAuthClient.fetch_usage(
          token: "tok",
          req_opts: [plug: stub_plug(401, %{"error" => "unauthorized"})]
        )
    end

    test "returns {:error, :rate_limited} on 429" do
      {:error, :rate_limited} =
        OAuthClient.fetch_usage(
          token: "tok",
          req_opts: [plug: stub_plug(429, %{"error" => "rate_limited"})]
        )
    end

    test "returns {:error, :network} on 500" do
      {:error, :network} =
        OAuthClient.fetch_usage(
          token: "tok",
          req_opts: [plug: stub_plug(500, %{"error" => "server_error"})]
        )
    end
  end

  # ---------------------------------------------------------------------------
  # fetch_plan/1
  # ---------------------------------------------------------------------------

  describe "fetch_plan/1 plan derivation" do
    test "returns plan from legacy shape: plan = 'max'" do
      {:ok, "max"} =
        OAuthClient.fetch_plan(
          token: "tok",
          req_opts: [plug: stub_plug(200, %{"plan" => "max"})]
        )
    end

    test "returns plan from legacy shape: plan = 'pro'" do
      {:ok, "pro"} =
        OAuthClient.fetch_plan(
          token: "tok",
          req_opts: [plug: stub_plug(200, %{"plan" => "pro"})]
        )
    end

    test "returns plan from legacy shape: plan = 'team'" do
      {:ok, "team"} =
        OAuthClient.fetch_plan(
          token: "tok",
          req_opts: [plug: stub_plug(200, %{"plan" => "team"})]
        )
    end

    test "derives team from organization_type = 'team'" do
      body = %{"organization" => %{"organization_type" => "team"}}

      {:ok, "team"} =
        OAuthClient.fetch_plan(token: "tok", req_opts: [plug: stub_plug(200, body)])
    end

    test "derives team from organization_type = 'enterprise'" do
      body = %{"organization" => %{"organization_type" => "enterprise"}}

      {:ok, "team"} =
        OAuthClient.fetch_plan(token: "tok", req_opts: [plug: stub_plug(200, body)])
    end

    test "derives max from account.has_claude_max = true" do
      body = %{"account" => %{"has_claude_max" => true, "has_claude_pro" => false}}

      {:ok, "max"} =
        OAuthClient.fetch_plan(token: "tok", req_opts: [plug: stub_plug(200, body)])
    end

    test "derives pro from account.has_claude_pro = true" do
      body = %{"account" => %{"has_claude_pro" => true, "has_claude_max" => false}}

      {:ok, "pro"} =
        OAuthClient.fetch_plan(token: "tok", req_opts: [plug: stub_plug(200, body)])
    end

    test "returns nil when nothing matches" do
      {:ok, nil} =
        OAuthClient.fetch_plan(
          token: "tok",
          req_opts: [plug: stub_plug(200, %{"account" => %{}})]
        )
    end
  end

  describe "fetch_plan/1 error handling" do
    test "returns {:error, :expired} on 401" do
      {:error, :expired} =
        OAuthClient.fetch_plan(
          token: "tok",
          req_opts: [plug: stub_plug(401, %{"error" => "unauthorized"})]
        )
    end

    test "returns {:error, :rate_limited} on 429" do
      {:error, :rate_limited} =
        OAuthClient.fetch_plan(
          token: "tok",
          req_opts: [plug: stub_plug(429, %{"error" => "rate_limited"})]
        )
    end

    test "returns {:error, :network} on 500" do
      {:error, :network} =
        OAuthClient.fetch_plan(
          token: "tok",
          req_opts: [plug: stub_plug(500, %{"error" => "server_error"})]
        )
    end
  end
end
