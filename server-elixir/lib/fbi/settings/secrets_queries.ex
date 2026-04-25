defmodule FBI.Settings.SecretsQueries do
  @moduledoc """
  Stub for project-scoped secret retrieval.
  Returns a map of `%{"KEY" => "value"}` environment variables for a project.
  """

  @spec decrypt_all(integer()) :: %{optional(String.t()) => String.t()}
  def decrypt_all(_project_id) do
    %{}
  end
end
