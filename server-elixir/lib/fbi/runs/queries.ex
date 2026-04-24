defmodule FBI.Runs.Queries do
  @moduledoc """
  Read/write helpers for the `runs` table. Search uses `LOWER(prompt) LIKE '%q%'`
  mirroring TS. List results can be returned unpaginated (array) OR paginated
  (%{items, total}) when the caller specifies any paging param.
  """

  import Ecto.Query

  alias FBI.Repo
  alias FBI.Runs.Run

  @type decoded :: map()

  @spec list(map()) :: [decoded()] | %{items: [decoded()], total: integer()}
  def list(params) do
    base = from(r in Run, order_by: [desc: r.id])

    base =
      base
      |> maybe_filter_state(params[:state])
      |> maybe_filter_project(params[:project_id])
      |> maybe_filter_q(params[:q])

    paged? = params[:limit] != nil or params[:offset] != nil

    if paged? do
      limit = clamp(params[:limit] || 50, 1, 200)
      offset = max(0, params[:offset] || 0)

      items = base |> limit(^limit) |> offset(^offset) |> Repo.all() |> Enum.map(&decode/1)
      total = base |> exclude(:order_by) |> select([r], count(r.id)) |> Repo.one()

      %{items: items, total: total}
    else
      base |> Repo.all() |> Enum.map(&decode/1)
    end
  end

  @spec get(integer()) :: {:ok, decoded()} | :not_found
  def get(id) do
    case Repo.get(Run, id) do
      nil -> :not_found
      r -> {:ok, decode(r)}
    end
  end

  @spec list_for_project(integer()) :: [decoded()]
  def list_for_project(project_id) do
    from(r in Run,
      where: r.project_id == ^project_id,
      order_by: [desc: r.created_at],
      limit: 50
    )
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec siblings(integer()) :: {:ok, [decoded()]} | :not_found
  def siblings(id) do
    case Repo.get(Run, id) do
      nil ->
        :not_found

      %Run{project_id: pid, prompt: prompt} ->
        rows =
          from(r in Run,
            where: r.project_id == ^pid and r.prompt == ^prompt and r.id != ^id,
            order_by: [desc: r.id],
            limit: 10
          )
          |> Repo.all()
          |> Enum.map(&decode/1)

        {:ok, rows}
    end
  end

  @doc "Compact summary used in the /api/projects index."
  @spec latest_for_project(integer()) ::
          %{id: integer(), state: String.t(), created_at: integer()} | nil
  def latest_for_project(project_id) do
    from(r in Run,
      where: r.project_id == ^project_id,
      order_by: [desc: r.id],
      limit: 1,
      select: %{id: r.id, state: r.state, created_at: r.created_at}
    )
    |> Repo.one()
  end

  @spec update_title(integer(), String.t()) :: {:ok, decoded()} | :not_found
  def update_title(id, title) do
    case Repo.get(Run, id) do
      nil ->
        :not_found

      r ->
        updated =
          r
          |> Run.changeset(%{title: title, title_locked: 0})
          |> Repo.update!()

        {:ok, decode(updated)}
    end
  end

  @spec delete(integer()) :: :ok
  def delete(id) do
    Repo.delete_all(from r in Run, where: r.id == ^id)
    :ok
  end

  defp maybe_filter_state(q, nil), do: q
  defp maybe_filter_state(q, s) when is_binary(s), do: from(r in q, where: r.state == ^s)

  defp maybe_filter_project(q, nil), do: q
  defp maybe_filter_project(q, pid) when is_integer(pid), do: from(r in q, where: r.project_id == ^pid)

  defp maybe_filter_q(q, nil), do: q
  defp maybe_filter_q(q, ""), do: q

  defp maybe_filter_q(q, text) when is_binary(text) do
    pattern = "%" <> String.downcase(text) <> "%"
    from(r in q, where: like(fragment("LOWER(?)", r.prompt), ^pattern))
  end

  defp clamp(n, lo, hi) when is_integer(n), do: n |> max(lo) |> min(hi)

  @doc "Build the plain JSON-ready map for a run. All keys mirror TS exactly."
  @spec decode(Run.t()) :: map()
  def decode(%Run{} = r) do
    Map.take(r, [
      :id, :project_id, :prompt, :branch_name, :state, :container_id, :log_path,
      :exit_code, :error, :head_commit, :started_at, :finished_at, :created_at,
      :state_entered_at, :model, :effort, :subagent_model,
      :resume_attempts, :next_resume_at, :claude_session_id, :last_limit_reset_at,
      :tokens_input, :tokens_output, :tokens_cache_read, :tokens_cache_create, :tokens_total,
      :usage_parse_errors, :title, :title_locked, :parent_run_id
    ])
  end
end
