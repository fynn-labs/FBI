defmodule FBI.Usage.RateLimitState do
  @moduledoc """
  Ecto schema for the `rate_limit_state` table.

  This table holds a single row (id = 1) representing the most recently
  observed global rate-limit state.  The singleton invariant is enforced
  by the database CHECK constraint `id = 1` and reinforced in `changeset/2`
  so application code cannot accidentally insert a second row.

  Because this module only maps data to/from the database, it is a plain
  `Ecto.Schema`—no GenServer, Supervisor, or other process behaviour is
  needed here.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :integer, autogenerate: false}

  schema "rate_limit_state" do
    field :plan, :string
    field :observed_at, :integer
    field :last_error, :string
    field :last_error_at, :integer
  end

  @type t :: %__MODULE__{
          id: integer() | nil,
          plan: String.t() | nil,
          observed_at: integer() | nil,
          last_error: String.t() | nil,
          last_error_at: integer() | nil
        }

  @doc """
  Validates and casts attributes for the singleton rate-limit state row.

  `id` is required and must equal `1`—any other value violates the
  singleton invariant.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(state, attrs) do
    state
    |> cast(attrs, [:id, :plan, :observed_at, :last_error, :last_error_at])
    |> validate_required([:id])
    |> validate_inclusion(:id, [1])
  end
end
