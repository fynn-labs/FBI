defmodule FBI.Uploads.Paths do
  @moduledoc "Path construction for draft and run uploads, using app-env roots."

  def draft_dir(token) when is_binary(token) do
    Path.join(Application.fetch_env!(:fbi, :draft_uploads_dir), token)
  end

  def run_uploads_dir(run_id) when is_integer(run_id) do
    Application.fetch_env!(:fbi, :runs_dir)
    |> Path.join(Integer.to_string(run_id))
    |> Path.join("uploads")
  end
end
