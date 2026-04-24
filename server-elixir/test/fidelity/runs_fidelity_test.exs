defmodule FBI.Fidelity.RunsFidelityTest do
  @moduledoc "Pins `/api/runs/:id` JSON shape against a canonical fixture."
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries, as: Projects
  alias FBI.Repo
  alias FBI.Runs.Run

  @fixture_path Path.expand("fixtures/run_snapshot.json", __DIR__)

  test "GET /api/runs/:id shape matches canonical fixture", %{conn: conn} do
    golden = @fixture_path |> File.read!() |> Jason.decode!()

    {:ok, p} = Projects.create(%{
      name: "rfid-#{System.unique_integer([:positive])}",
      repo_url: "git@github.com:owner/r.git"
    })

    run = Repo.insert!(struct(Run, %{
      project_id: p.id,
      prompt: "x",
      branch_name: "b",
      state: "succeeded",
      log_path: "/tmp/x.log",
      created_at: System.system_time(:millisecond)
    }))

    actual = conn |> get("/api/runs/#{run.id}") |> json_response(200)

    assert_same_shape!(actual, golden)
  end

  # shape helpers copied from ProjectsFidelityTest (see comment in usage_fidelity_test.exs)
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
      actual == [] -> flunk("expected non-empty list")
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
