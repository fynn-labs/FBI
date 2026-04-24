defmodule FBI.Config.DefaultsTest do
  @moduledoc """
  Mirrors the behaviour of TS's `parseList` + `legacyDefaultLists` from
  `src/server/config.ts`.  The `list/0` contract is: read two env vars
  (`FBI_DEFAULT_MARKETPLACES`, `FBI_DEFAULT_PLUGINS`), split on `,` or
  newline, trim each element, drop empties.
  """

  use ExUnit.Case, async: false

  alias FBI.Config.Defaults

  # Helper: set env vars, run the assertion, always clean up.
  defp with_env(kvs, fun) do
    original =
      Enum.map(kvs, fn {k, _} -> {k, System.get_env(k)} end)

    Enum.each(kvs, fn {k, v} ->
      if v == nil, do: System.delete_env(k), else: System.put_env(k, v)
    end)

    try do
      fun.()
    after
      Enum.each(original, fn
        {k, nil} -> System.delete_env(k)
        {k, v} -> System.put_env(k, v)
      end)
    end
  end

  describe "list/0" do
    test "returns empty lists when env vars are unset" do
      with_env([{"FBI_DEFAULT_MARKETPLACES", nil}, {"FBI_DEFAULT_PLUGINS", nil}], fn ->
        assert Defaults.list() == %{marketplaces: [], plugins: []}
      end)
    end

    test "splits on commas and trims whitespace" do
      with_env(
        [{"FBI_DEFAULT_MARKETPLACES", "foo, bar ,baz"}, {"FBI_DEFAULT_PLUGINS", nil}],
        fn ->
          assert Defaults.list().marketplaces == ["foo", "bar", "baz"]
        end
      )
    end

    test "splits on newlines" do
      with_env(
        [{"FBI_DEFAULT_MARKETPLACES", "foo\nbar\nbaz"}, {"FBI_DEFAULT_PLUGINS", nil}],
        fn ->
          assert Defaults.list().marketplaces == ["foo", "bar", "baz"]
        end
      )
    end

    test "drops empty entries and whitespace-only entries" do
      with_env([{"FBI_DEFAULT_MARKETPLACES", "foo,,  ,bar"}, {"FBI_DEFAULT_PLUGINS", nil}], fn ->
        assert Defaults.list().marketplaces == ["foo", "bar"]
      end)
    end

    test "handles mixed commas and newlines" do
      with_env(
        [{"FBI_DEFAULT_MARKETPLACES", "a,b\nc ,  d"}, {"FBI_DEFAULT_PLUGINS", "x\ny"}],
        fn ->
          assert Defaults.list() == %{
                   marketplaces: ["a", "b", "c", "d"],
                   plugins: ["x", "y"]
                 }
        end
      )
    end
  end
end
