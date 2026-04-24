defmodule FBI.Settings.Queries do
  @moduledoc """
  Read/write helpers for the singleton `settings` row.

  This is a plain module (no GenServer): all state lives in the database and
  every call roundtrips through `FBI.Repo`.  Chosen over a stateful process
  because the TS server still writes this row (e.g. during `POST /api/settings/run-gc`),
  so any in-memory cache would go stale.  The repo is the single source of truth.

  Two behaviors worth naming:

  - **Seed-on-read.**  `get/0` inserts the default row if it does not exist,
    mirroring the TS `SettingsRepo.get/0` contract.  Callers never see a
    missing-row error.
  - **Int ↔ bool translation.**  Booleans are stored as SQLite integers because
    TS wrote the schema; the public API exposes true booleans to match the
    existing JSON contract.
  """

  alias FBI.Repo
  alias FBI.Settings.Setting

  @typedoc """
  The decoded settings map returned by `get/0` and `update/1`.  Keys are
  atoms (Phoenix serializes them to snake_case JSON strings).  Boolean
  fields are true booleans; list fields are decoded from the JSON columns.
  """
  @type decoded :: %{
          global_prompt: String.t(),
          notifications_enabled: boolean(),
          concurrency_warn_at: integer(),
          image_gc_enabled: boolean(),
          last_gc_at: integer() | nil,
          last_gc_count: integer() | nil,
          last_gc_bytes: integer() | nil,
          global_marketplaces: [String.t()],
          global_plugins: [String.t()],
          auto_resume_enabled: boolean(),
          auto_resume_max_attempts: integer(),
          usage_notifications_enabled: boolean(),
          updated_at: integer()
        }

  @typedoc """
  The accepted patch map for `update/1`.  Every key is optional; booleans are
  accepted for int-stored columns; list fields are encoded to JSON before
  write.
  """
  @type patch :: %{optional(atom()) => any()}

  @doc """
  Returns the singleton settings row, seeding defaults if the table is empty.

  Never raises for missing rows — the TS contract promises a readable row
  from first access, and the React UI relies on that.
  """
  @spec get() :: decoded()
  def get do
    case Repo.get(Setting, 1) do
      nil ->
        now = System.system_time(:millisecond)

        %Setting{id: 1, updated_at: now}
        |> Setting.changeset(%{})
        |> Repo.insert!(on_conflict: :nothing, conflict_target: :id)

        # Re-read so we pick up column defaults applied by the DB.
        # `on_conflict: :nothing` is safe under concurrent seeding: at most one
        # inserter wins, the others no-op and fall through to the read below.
        Repo.get!(Setting, 1) |> decode()

      setting ->
        decode(setting)
    end
  end

  @doc """
  Merges `patch` into the singleton row and returns the decoded result.

  Returns `{:error, changeset}` when validation fails (currently only
  `auto_resume_max_attempts` outside `1..20`) — the controller turns this
  into a 400 response with the same error message as the TS handler.

  Unlike the TS `update/1`, which read-modify-writes and returns the merged
  map unconditionally, this version routes through a changeset so validation
  runs on the final state.  The end-to-end contract (valid patches → 200 +
  updated row; invalid → 400) is identical.
  """
  @spec update(patch()) :: decoded() | {:error, Ecto.Changeset.t()}
  def update(patch) do
    existing = Repo.get(Setting, 1) || %Setting{id: 1}
    attrs = build_attrs(patch, existing)

    changeset = Setting.changeset(existing, attrs)

    # `Setting.changeset/2` returns a changeset whose `:valid?` flag is the
    # single decision point.  Using `with` here would add indirection for
    # nothing; a plain `if` matches how Phase 1 phrased similar logic.
    if changeset.valid? do
      case Repo.insert_or_update(changeset) do
        {:ok, _setting} -> Repo.get!(Setting, 1) |> decode()
        {:error, cs} -> {:error, cs}
      end
    else
      {:error, changeset}
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Merge the caller's patch into the existing row, translating booleans to
  # integers and lists to JSON strings.  Any key the caller did not touch keeps
  # its existing value so the TS partial-update contract is preserved.
  defp build_attrs(patch, existing) do
    now = System.system_time(:millisecond)

    %{
      id: 1,
      global_prompt: Map.get(patch, :global_prompt, existing.global_prompt),
      notifications_enabled:
        bool_to_int(Map.get(patch, :notifications_enabled), existing.notifications_enabled),
      concurrency_warn_at:
        Map.get(patch, :concurrency_warn_at, existing.concurrency_warn_at),
      image_gc_enabled:
        bool_to_int(Map.get(patch, :image_gc_enabled), existing.image_gc_enabled),
      global_marketplaces_json:
        list_to_json(Map.get(patch, :global_marketplaces), existing.global_marketplaces_json),
      global_plugins_json:
        list_to_json(Map.get(patch, :global_plugins), existing.global_plugins_json),
      auto_resume_enabled:
        bool_to_int(Map.get(patch, :auto_resume_enabled), existing.auto_resume_enabled),
      auto_resume_max_attempts:
        Map.get(patch, :auto_resume_max_attempts, existing.auto_resume_max_attempts),
      usage_notifications_enabled:
        bool_to_int(
          Map.get(patch, :usage_notifications_enabled),
          existing.usage_notifications_enabled
        ),
      updated_at: now
    }
  end

  defp bool_to_int(nil, existing), do: existing
  defp bool_to_int(true, _existing), do: 1
  defp bool_to_int(false, _existing), do: 0
  defp bool_to_int(v, _existing) when v in [0, 1], do: v

  defp list_to_json(nil, existing_json), do: existing_json

  defp list_to_json(list, _existing_json) when is_list(list) do
    Jason.encode!(list)
  end

  defp decode(%Setting{} = s) do
    %{
      global_prompt: s.global_prompt,
      notifications_enabled: s.notifications_enabled == 1,
      concurrency_warn_at: s.concurrency_warn_at,
      image_gc_enabled: s.image_gc_enabled == 1,
      last_gc_at: s.last_gc_at,
      last_gc_count: s.last_gc_count,
      last_gc_bytes: s.last_gc_bytes,
      global_marketplaces: Jason.decode!(s.global_marketplaces_json || "[]"),
      global_plugins: Jason.decode!(s.global_plugins_json || "[]"),
      auto_resume_enabled: s.auto_resume_enabled == 1,
      auto_resume_max_attempts: s.auto_resume_max_attempts,
      usage_notifications_enabled: s.usage_notifications_enabled == 1,
      updated_at: s.updated_at
    }
  end
end
