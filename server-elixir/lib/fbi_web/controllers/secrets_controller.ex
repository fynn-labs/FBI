defmodule FBIWeb.SecretsController do
  @moduledoc """
  Project-scoped secret names (list), value write (PUT, encrypted), and delete.

  Mirrors `src/server/api/secrets.ts`. Values are never returned over HTTP;
  `list/1` returns only `{name, created_at}` pairs.
  """
  use FBIWeb, :controller

  alias FBI.Projects.SecretQueries

  def index(conn, %{"id" => id_str}) do
    case Integer.parse(id_str) do
      {id, ""} -> json(conn, SecretQueries.list(id))
      _ -> json(conn, [])
    end
  end

  def put(conn, %{"id" => id_str, "name" => name} = params) do
    with {:ok, id} <- parse_id(id_str),
         value when is_binary(value) <- params["value"] do
      SecretQueries.upsert(id, name, value)
      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(400) |> json(%{error: "value required"})
    end
  end

  def delete(conn, %{"id" => id_str, "name" => name}) do
    case parse_id(id_str) do
      {:ok, id} ->
        SecretQueries.delete(id, name)
        send_resp(conn, 204, "")

      :error ->
        send_resp(conn, 204, "")
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
