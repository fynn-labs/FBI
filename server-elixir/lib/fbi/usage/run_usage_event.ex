defmodule FBI.Usage.RunUsageEvent do
  @moduledoc """
  Ecto schema for the `run_usage_events` table.

  Each row records token consumption and rate-limit header snapshots for a
  single API call made during a run.  The `run_id` column links back to the
  run that produced the event; the `ts` column is a Unix timestamp (integer
  milliseconds) recorded at insertion time by the writer.

  This is a plain `Ecto.Schema` used for reading event rows.  No changeset
  is provided because this server only reads these rows—writes are performed
  by the process that owns the agent runtime.
  """

  use Ecto.Schema

  schema "run_usage_events" do
    field :run_id, :integer
    field :ts, :integer
    field :model, :string
    field :input_tokens, :integer
    field :output_tokens, :integer
    field :cache_read_tokens, :integer
    field :cache_create_tokens, :integer
    field :rl_requests_remaining, :integer
    field :rl_requests_limit, :integer
    field :rl_tokens_remaining, :integer
    field :rl_tokens_limit, :integer
    field :rl_reset_at, :integer
  end

  @type t :: %__MODULE__{
          id: integer() | nil,
          run_id: integer() | nil,
          ts: integer() | nil,
          model: String.t() | nil,
          input_tokens: integer() | nil,
          output_tokens: integer() | nil,
          cache_read_tokens: integer() | nil,
          cache_create_tokens: integer() | nil,
          rl_requests_remaining: integer() | nil,
          rl_requests_limit: integer() | nil,
          rl_tokens_remaining: integer() | nil,
          rl_tokens_limit: integer() | nil,
          rl_reset_at: integer() | nil
        }
end
