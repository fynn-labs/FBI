defmodule FBI.Runs.Run do
  @moduledoc """
  Ecto schema for the `runs` table. Mirrors the column order + types + defaults
  of TS's schema + ALTERs. `title_locked` is 0/1 to match TS SQLite convention.
  """
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :integer, autogenerate: false}

  schema "runs" do
    field :project_id, :integer
    field :prompt, :string
    field :branch_name, :string
    field :state, :string
    field :container_id, :string
    field :log_path, :string
    field :exit_code, :integer
    field :error, :string
    field :head_commit, :string
    field :started_at, :integer
    field :finished_at, :integer
    field :created_at, :integer
    field :state_entered_at, :integer, default: 0
    field :model, :string
    field :effort, :string
    field :subagent_model, :string
    field :resume_attempts, :integer, default: 0
    field :next_resume_at, :integer
    field :claude_session_id, :string
    field :last_limit_reset_at, :integer
    field :tokens_input, :integer, default: 0
    field :tokens_output, :integer, default: 0
    field :tokens_cache_read, :integer, default: 0
    field :tokens_cache_create, :integer, default: 0
    field :tokens_total, :integer, default: 0
    field :usage_parse_errors, :integer, default: 0
    field :title, :string
    field :title_locked, :integer, default: 0
    field :parent_run_id, :integer
  end

  @type t :: %__MODULE__{}

  @all_fields ~w(
    project_id prompt branch_name state container_id log_path exit_code error
    head_commit started_at finished_at created_at state_entered_at
    model effort subagent_model
    resume_attempts next_resume_at claude_session_id last_limit_reset_at
    tokens_input tokens_output tokens_cache_read tokens_cache_create tokens_total
    usage_parse_errors title title_locked parent_run_id
  )a

  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(run, attrs) do
    run
    |> cast(attrs, [:id | @all_fields])
    |> validate_required([:project_id, :prompt, :branch_name, :state, :log_path, :created_at])
    |> validate_inclusion(:title_locked, [0, 1])
  end
end
