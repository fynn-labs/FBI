defmodule FBI.Fidelity.UsageFidelityTest do
  @moduledoc """
  Pins the JSON shape of `/api/usage` to a canonical fixture so accidental
  drift in keys, types, or nesting fails CI before it reaches the frontend.

  Compares shape and key names only; timestamps and specific values can
  legitimately vary between runs.
  """

  use FBIWeb.ConnCase, async: true

  alias FBI.Repo
  alias FBI.Usage.{RateLimitBucket, RateLimitState}

  @fixture_path Path.expand("fixtures/usage_snapshot.json", __DIR__)

  test "GET /api/usage shape matches the canonical fixture", %{conn: conn} do
    golden = @fixture_path |> File.read!() |> Jason.decode!()

    # Seed enough state so the response includes a bucket + pacing entry.
    Repo.insert!(%RateLimitState{id: 1, plan: "max", observed_at: 1_000})

    Repo.insert!(%RateLimitBucket{
      bucket_id: "five_hour",
      utilization: 0.5,
      reset_at: 18_000_000,
      window_started_at: 0,
      observed_at: 1_000
    })

    actual = conn |> get("/api/usage") |> json_response(200)

    assert_same_shape!(actual, golden)
  end

  # Recursive shape-equality check.
  defp assert_same_shape!(actual, golden) when is_map(actual) and is_map(golden) do
    a_keys = actual |> Map.keys() |> Enum.sort()
    g_keys = golden |> Map.keys() |> Enum.sort()

    assert a_keys == g_keys,
           "Top-level key mismatch:\n  expected: #{inspect(g_keys)}\n  got:      #{inspect(a_keys)}"

    Enum.each(g_keys, fn k ->
      assert_same_shape!(Map.get(actual, k), Map.get(golden, k))
    end)
  end

  defp assert_same_shape!(actual, golden) when is_list(actual) and is_list(golden) do
    cond do
      actual == [] and golden == [] -> :ok
      # actual may be richer than fixture
      golden == [] -> :ok
      actual == [] -> flunk("expected non-empty list (matching fixture shape)")
      true -> assert_same_shape!(hd(actual), hd(golden))
    end
  end

  defp assert_same_shape!(actual, golden) do
    assert shape_type(actual) == shape_type(golden),
           "Type mismatch:\n  expected: #{shape_type(golden)}\n  got:      #{shape_type(actual)}"
  end

  defp shape_type(nil), do: :nil_t
  defp shape_type(v) when is_boolean(v), do: :boolean
  defp shape_type(v) when is_number(v), do: :number
  defp shape_type(v) when is_binary(v), do: :string
  defp shape_type(v) when is_list(v), do: :list
  defp shape_type(v) when is_map(v), do: :map
end
