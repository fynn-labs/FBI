defmodule FBI.Fidelity.SettingsFidelityTest do
  @moduledoc """
  Pins the JSON shape of `/api/settings` to a canonical fixture so accidental
  drift in keys, types, or nesting fails CI before it reaches the frontend.

  Compares shape and key names only; `updated_at` legitimately varies per
  run.  Deleted at Phase 9 cutover alongside the rest of the fidelity harness.
  """

  use FBIWeb.ConnCase, async: false

  @fixture_path Path.expand("fixtures/settings_snapshot.json", __DIR__)

  test "GET /api/settings shape matches the canonical fixture", %{conn: conn} do
    golden = @fixture_path |> File.read!() |> Jason.decode!()

    actual = conn |> get("/api/settings") |> json_response(200)

    assert_same_shape!(actual, golden)
  end

  # Recursive shape-equality check — copied from usage_fidelity_test.exs.
  # Intentionally duplicated rather than extracted to a support module
  # because the fidelity harness disappears at cutover and depending on
  # a shared helper would create a cleanup tangle.
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
