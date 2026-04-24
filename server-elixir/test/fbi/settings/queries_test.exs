defmodule FBI.Settings.QueriesTest do
  @moduledoc """
  Tests `FBI.Settings.Queries`.  The queries module owns the singleton-row
  invariant (id = 1), the int↔bool translation, and the JSON-encoded list
  fields — all three are behaviors the TS `SettingsRepo` keeps internal, so
  we have to verify them explicitly on the Elixir side.
  """

  # async: false because the singleton row lives at id=1 and tests that run
  # concurrently would step on each other's updates even with the SQL sandbox
  # (the sandbox isolates transactions, not logical row identity, and the
  # sandbox does not actually prevent two tests from writing id=1 in the same
  # wall-clock window on different sandbox transactions).
  use FBI.DataCase, async: false

  alias FBI.Settings.Queries

  describe "get/0" do
    test "returns defaults when the table is empty" do
      settings = Queries.get()

      assert settings.global_prompt == ""
      assert settings.notifications_enabled == true
      assert settings.concurrency_warn_at == 3
      assert settings.image_gc_enabled == false
      assert settings.last_gc_at == nil
      assert settings.last_gc_count == nil
      assert settings.last_gc_bytes == nil
      assert settings.global_marketplaces == []
      assert settings.global_plugins == []
      assert settings.auto_resume_enabled == true
      assert settings.auto_resume_max_attempts == 5
      assert settings.usage_notifications_enabled == false
      assert is_integer(settings.updated_at)
    end

    test "decodes JSON list columns into string lists" do
      Queries.update(%{
        global_marketplaces: ["foo", "bar"],
        global_plugins: ["baz"]
      })

      settings = Queries.get()
      assert settings.global_marketplaces == ["foo", "bar"]
      assert settings.global_plugins == ["baz"]
    end

    test "maps integer booleans to Elixir booleans" do
      Queries.update(%{notifications_enabled: false, auto_resume_enabled: false})

      settings = Queries.get()
      assert settings.notifications_enabled == false
      assert settings.auto_resume_enabled == false
    end
  end

  describe "update/1" do
    test "updates provided fields and leaves others unchanged" do
      before = Queries.get()

      after_patch = Queries.update(%{global_prompt: "new-prompt"})

      assert after_patch.global_prompt == "new-prompt"
      assert after_patch.concurrency_warn_at == before.concurrency_warn_at
      assert after_patch.updated_at >= before.updated_at
    end

    test "accepts boolean inputs for integer-stored columns" do
      result = Queries.update(%{usage_notifications_enabled: true})

      assert result.usage_notifications_enabled == true
      assert Queries.get().usage_notifications_enabled == true
    end

    test "bumps updated_at monotonically" do
      a = Queries.update(%{global_prompt: "a"})
      # Ensure at least 1 ms elapses so the monotonic-ish comparison holds.
      _ = :timer.sleep(2)
      b = Queries.update(%{global_prompt: "b"})

      assert b.updated_at > a.updated_at
    end

    test "rejects auto_resume_max_attempts out of range" do
      assert {:error, changeset} = Queries.update(%{auto_resume_max_attempts: 0})
      assert "must be greater than or equal to 1" in errors_on(changeset).auto_resume_max_attempts

      assert {:error, changeset} = Queries.update(%{auto_resume_max_attempts: 21})
      assert "must be less than or equal to 20" in errors_on(changeset).auto_resume_max_attempts
    end
  end
end
