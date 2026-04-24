defmodule FBI.Settings.Setting do
  @moduledoc """
  Ecto schema for the `settings` table.

  Holds a **single row** (`id = 1`) representing the server's global user
  preferences.  The singleton invariant is enforced both by the SQLite CHECK
  constraint and by `validate_inclusion/3` below so application code cannot
  accidentally insert a second row.

  This is a plain `Ecto.Schema` — no GenServer/Supervisor is needed because
  the settings row holds no in-memory state beyond its database row.  Reads
  and writes go directly through `FBI.Repo`.

  Boolean fields are stored as `:integer` (0/1) because the TS server (which
  still owns the schema) uses SQLite `INTEGER` columns for booleans.  The
  `FBI.Settings.Queries` module handles int-to-bool translation so the
  external JSON contract stays boolean-typed.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :integer, autogenerate: false}

  schema "settings" do
    field :global_prompt, :string, default: ""
    field :notifications_enabled, :integer, default: 1
    field :concurrency_warn_at, :integer, default: 3
    field :image_gc_enabled, :integer, default: 0
    field :last_gc_at, :integer
    field :last_gc_count, :integer
    field :last_gc_bytes, :integer
    field :global_marketplaces_json, :string, default: "[]"
    field :global_plugins_json, :string, default: "[]"
    field :auto_resume_enabled, :integer, default: 1
    field :auto_resume_max_attempts, :integer, default: 5
    field :usage_notifications_enabled, :integer, default: 0
    field :tokens_total_recomputed_at, :integer
    field :updated_at, :integer
  end

  @type t :: %__MODULE__{
          id: integer() | nil,
          global_prompt: String.t(),
          notifications_enabled: integer(),
          concurrency_warn_at: integer(),
          image_gc_enabled: integer(),
          last_gc_at: integer() | nil,
          last_gc_count: integer() | nil,
          last_gc_bytes: integer() | nil,
          global_marketplaces_json: String.t(),
          global_plugins_json: String.t(),
          auto_resume_enabled: integer(),
          auto_resume_max_attempts: integer(),
          usage_notifications_enabled: integer(),
          tokens_total_recomputed_at: integer() | nil,
          updated_at: integer() | nil
        }

  @all_fields [
    :id,
    :global_prompt,
    :notifications_enabled,
    :concurrency_warn_at,
    :image_gc_enabled,
    :last_gc_at,
    :last_gc_count,
    :last_gc_bytes,
    :global_marketplaces_json,
    :global_plugins_json,
    :auto_resume_enabled,
    :auto_resume_max_attempts,
    :usage_notifications_enabled,
    :tokens_total_recomputed_at,
    :updated_at
  ]

  @doc """
  Changeset for upserting the singleton settings row.

  Every column is cast (there are no secrets or server-only fields to hide);
  `id` is required and pinned to `1`; booleans-as-integers are clamped to
  `{0, 1}`; `auto_resume_max_attempts` must be `1..20` — the same range the
  TS `PATCH /api/settings` handler enforces in `src/server/api/settings.ts`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(setting, attrs) do
    setting
    |> cast(attrs, @all_fields)
    |> validate_required([:id, :updated_at])
    |> validate_inclusion(:id, [1])
    |> validate_inclusion(:notifications_enabled, [0, 1])
    |> validate_inclusion(:image_gc_enabled, [0, 1])
    |> validate_inclusion(:auto_resume_enabled, [0, 1])
    |> validate_inclusion(:usage_notifications_enabled, [0, 1])
    |> validate_number(:auto_resume_max_attempts,
      greater_than_or_equal_to: 1,
      less_than_or_equal_to: 20
    )
  end
end
