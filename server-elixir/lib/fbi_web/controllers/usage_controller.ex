defmodule FBIWeb.UsageController do
  @moduledoc """
  REST controllers for the usage subsystem.

  Three endpoints are handled here:

  - `GET /api/usage` — current snapshot built by `FBI.Usage.Poller.snapshot/0`,
    which reads live database state.
  - `GET /api/usage/daily` — per-day token aggregates from
    `FBI.Usage.Queries.list_daily_usage/1`.
  - `GET /api/usage/runs/:id` — per-model token breakdown for a single run from
    `FBI.Usage.Queries.get_run_breakdown/1`.

  Response shapes are matched to the existing server contract so the React
  frontend remains compatible without modification.
  """

  use FBIWeb, :controller

  @doc "GET /api/usage — current snapshot from the poller."
  def show(conn, _params) do
    json(conn, FBI.Usage.Poller.snapshot())
  end

  @doc "GET /api/usage/daily — daily token aggregates; accepts optional `?days=N` (default 14)."
  def daily(conn, params) do
    days = parse_days(params["days"])

    json(
      conn,
      FBI.Usage.Queries.list_daily_usage(days: days, now: System.system_time(:millisecond))
    )
  end

  @doc "GET /api/usage/runs/:id — per-model breakdown for a run; returns 400 if id is not a valid integer."
  def run_breakdown(conn, %{"id" => id}) do
    case Integer.parse(id) do
      {run_id, ""} -> json(conn, FBI.Usage.Queries.get_run_breakdown(run_id))
      _ -> conn |> put_status(400) |> json(%{error: "invalid id"})
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp parse_days(nil), do: 14

  defp parse_days(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, _} -> n
      :error -> 14
    end
  end
end
