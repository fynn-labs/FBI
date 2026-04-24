defmodule FBIWeb.SettingsController do
  @moduledoc """
  REST endpoints for the singleton settings row.

  Routes served here:

  - `GET /api/settings` — returns the decoded row (booleans as booleans,
    list columns as JSON arrays, timestamp as integer ms).
  - `PATCH /api/settings` — partial update; rejects `auto_resume_max_attempts`
    outside `1..20` with a 400 whose error message matches the TS handler
    byte-for-byte so clients with cached error strings keep working.

  `POST /api/settings/run-gc` is intentionally **not** served here — it
  depends on the orchestrator (Phase 7) and continues to be proxied to TS
  via the catch-all in `FBIWeb.Router`.

  This is a plain Phoenix controller — no process state, no supervision
  concerns.  All behaviour delegates to `FBI.Settings.Queries`.
  """

  use FBIWeb, :controller

  alias FBI.Settings.Queries

  @doc "GET /api/settings — returns the decoded singleton row."
  def show(conn, _params) do
    json(conn, Queries.get())
  end

  @doc """
  PATCH /api/settings — applies a partial update.

  Accepts the same keys as the TS handler: `global_prompt`,
  `notifications_enabled`, `concurrency_warn_at`, `image_gc_enabled`,
  `global_marketplaces`, `global_plugins`, `auto_resume_enabled`,
  `auto_resume_max_attempts`, `usage_notifications_enabled`.
  """
  def update(conn, params) do
    # `params` arrives with string keys (Phoenix JSON parser); the queries
    # module works on atom keys.  `atomize/1` restricts conversion to a
    # known allow-list so we never call `String.to_atom/1` on user input.
    patch = atomize(params)

    case Queries.update(patch) do
      {:error, %Ecto.Changeset{errors: errors}} ->
        # The TS handler returns exactly this string for the only validation
        # case; reproduce it verbatim so clients with hard-coded error
        # matchers keep working.  Any future validations should branch here
        # to preserve the single-error-at-a-time contract.
        cond do
          Keyword.has_key?(errors, :auto_resume_max_attempts) ->
            conn
            |> put_status(400)
            |> json(%{error: "auto_resume_max_attempts must be an integer between 1 and 20"})

          true ->
            conn
            |> put_status(400)
            |> json(%{error: "invalid settings patch"})
        end

      decoded when is_map(decoded) ->
        json(conn, decoded)
    end
  end

  # Translate string-keyed params into atom-keyed patches.  Only the known
  # field set is translated; anything else is silently dropped — same as the
  # TS handler, which ignores unknown fields (its body type is the sole gate).
  @known_string_keys %{
    "global_prompt" => :global_prompt,
    "notifications_enabled" => :notifications_enabled,
    "concurrency_warn_at" => :concurrency_warn_at,
    "image_gc_enabled" => :image_gc_enabled,
    "global_marketplaces" => :global_marketplaces,
    "global_plugins" => :global_plugins,
    "auto_resume_enabled" => :auto_resume_enabled,
    "auto_resume_max_attempts" => :auto_resume_max_attempts,
    "usage_notifications_enabled" => :usage_notifications_enabled
  }

  defp atomize(params) when is_map(params) do
    Enum.reduce(@known_string_keys, %{}, fn {string_key, atom_key}, acc ->
      case Map.fetch(params, string_key) do
        {:ok, v} -> Map.put(acc, atom_key, v)
        :error -> acc
      end
    end)
  end
end
