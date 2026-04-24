defmodule FBIWeb.FilesController do
  @moduledoc """
  GET /api/runs/:id/files — returns the file-change list via `gh api compare`.

  Differs from TS: the "live container" path (`orchestrator.getLastFiles`) is
  skipped during the crossover. `live` is always `false`. Finished runs and
  runs whose branch is pushed return correct data.
  """

  use FBIWeb, :controller

  alias FBI.Github.{Client, Repo}
  alias FBI.Projects.Queries, as: Projects
  alias FBI.Runs.Queries, as: Runs

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         {:ok, project} <- Projects.get(run.project_id),
         {:ok, repo} <- Repo.parse(project.repo_url),
         true <- Client.available?() do
      case Client.compare_files(repo, project.default_branch, run.branch_name) do
        {:ok, files} when is_list(files) ->
          head_files =
            Enum.map(files, fn f ->
              %{
                filename: f["filename"],
                additions: f["additions"] || 0,
                deletions: f["deletions"] || 0,
                status: map_status(f["status"])
              }
            end)

          json(conn, %{
            dirty: [],
            head: nil,
            headFiles: head_files,
            branchBase: %{
              base: project.default_branch,
              ahead: if(length(head_files) > 0, do: 1, else: 0),
              behind: 0
            },
            live: false
          })

        _ ->
          json(conn, empty_payload(project.default_branch))
      end
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
      _ -> json(conn, %{dirty: [], head: nil, headFiles: [], branchBase: nil, live: false})
    end
  end

  defp empty_payload(base) do
    %{dirty: [], head: nil, headFiles: [], branchBase: %{base: base, ahead: 0, behind: 0}, live: false}
  end

  defp map_status("added"), do: "A"
  defp map_status("removed"), do: "D"
  defp map_status("renamed"), do: "R"
  defp map_status(_), do: "M"

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
