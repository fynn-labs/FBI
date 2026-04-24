defmodule FBI.Projects.SecretQueries do
  @moduledoc """
  Read/write helpers for `project_secrets`. Encryption happens on `upsert/3`
  via `FBI.Crypto.encrypt/2` using the key in application env
  `:fbi, :secrets_key_path`. GET only returns names + created_at; values
  are never exposed over HTTP.
  """

  import Ecto.Query

  alias FBI.Crypto
  alias FBI.Projects.Secret
  alias FBI.Repo

  @spec list(integer()) :: [%{name: String.t(), created_at: integer()}]
  def list(project_id) do
    from(s in Secret,
      where: s.project_id == ^project_id,
      order_by: [asc: s.name],
      select: %{name: s.name, created_at: s.created_at}
    )
    |> Repo.all()
  end

  @spec upsert(integer(), String.t(), String.t()) :: :ok
  def upsert(project_id, name, value) do
    key = load_key()
    value_enc = Crypto.encrypt(key, value)
    now = System.system_time(:millisecond)

    %Secret{}
    |> Secret.changeset(%{
      project_id: project_id,
      name: name,
      value_enc: value_enc,
      created_at: now
    })
    |> Repo.insert(
      on_conflict: [set: [value_enc: value_enc, created_at: now]],
      conflict_target: [:project_id, :name]
    )

    :ok
  end

  @spec delete(integer(), String.t()) :: :ok
  def delete(project_id, name) do
    Repo.delete_all(from s in Secret, where: s.project_id == ^project_id and s.name == ^name)
    :ok
  end

  defp load_key do
    case Application.get_env(:fbi, :secrets_key_path) do
      nil -> raise "secrets_key_path not configured"
      path -> Crypto.load_key!(path)
    end
  end
end
