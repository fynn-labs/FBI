defmodule FBI.Usage.RateLimitBucket do
  @moduledoc """
  Ecto schema for the `rate_limit_buckets` table.

  Each row describes one named rate-limit dimension (e.g. `"requests"` or
  `"tokens"`) along with its current utilization and window metadata.
  Utilization is expressed as a fraction in [0.0, 1.0].

  This is a plain `Ecto.Schema`—it maps rows to Elixir structs and provides
  a changeset for validation.  Business logic (pacing decisions) lives in
  `FBI.Usage.Pacing`.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:bucket_id, :string, autogenerate: false}

  schema "rate_limit_buckets" do
    field :utilization, :float
    field :reset_at, :integer
    field :window_started_at, :integer
    field :last_notified_threshold, :integer
    field :last_notified_reset_at, :integer
    field :observed_at, :integer
  end

  @type t :: %__MODULE__{
          bucket_id: String.t() | nil,
          utilization: float() | nil,
          reset_at: integer() | nil,
          window_started_at: integer() | nil,
          last_notified_threshold: integer() | nil,
          last_notified_reset_at: integer() | nil,
          observed_at: integer() | nil
        }

  @doc """
  Validates and casts attributes for a rate-limit bucket row.

  Requires `bucket_id`, `utilization`, and `observed_at`.
  `utilization` must be in the range [0.0, 1.0].
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(bucket, attrs) do
    bucket
    |> cast(attrs, [
      :bucket_id,
      :utilization,
      :reset_at,
      :window_started_at,
      :last_notified_threshold,
      :last_notified_reset_at,
      :observed_at
    ])
    |> validate_required([:bucket_id, :utilization, :observed_at])
    |> validate_number(:utilization, greater_than_or_equal_to: 0.0, less_than_or_equal_to: 1.0)
  end
end
