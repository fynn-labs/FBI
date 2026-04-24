defmodule FBI.Repo.Migrations.CreateUsageTables do
  use Ecto.Migration

  def change do
    create table(:run_usage_events, primary_key: false) do
      add :id, :integer, primary_key: true
      add :run_id, :integer, null: false
      add :ts, :integer, null: false
      add :model, :text, null: false
      add :input_tokens, :integer, null: false
      add :output_tokens, :integer, null: false
      add :cache_read_tokens, :integer, null: false
      add :cache_create_tokens, :integer, null: false
      add :rl_requests_remaining, :integer
      add :rl_requests_limit, :integer
      add :rl_tokens_remaining, :integer
      add :rl_tokens_limit, :integer
      add :rl_reset_at, :integer
    end

    create index(:run_usage_events, [:run_id, :ts], name: :idx_run_usage_events_run)
    create index(:run_usage_events, [:ts], name: :idx_run_usage_events_ts)

    create table(:rate_limit_state, primary_key: false) do
      add :id, :integer, primary_key: true, check: %{name: "id_must_be_one", expr: "id = 1"}
      add :plan, :text
      add :observed_at, :integer
      add :last_error, :text
      add :last_error_at, :integer
    end

    create table(:rate_limit_buckets, primary_key: false) do
      add :bucket_id, :text, primary_key: true
      add :utilization, :real, null: false
      add :reset_at, :integer
      add :window_started_at, :integer
      add :last_notified_threshold, :integer
      add :last_notified_reset_at, :integer
      add :observed_at, :integer, null: false
    end
  end
end
