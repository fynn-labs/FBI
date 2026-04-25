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

  @spec update_title(integer(), String.t(), boolean()) :: {:ok, decoded()} | :not_found
  def update_title(id, title, lock \\ false) do
    case Repo.get(Run, id) do
      nil ->
        :not_found

      r ->
        attrs =
          if lock, do: %{title: title, title_locked: 1}, else: %{title: title, title_locked: 0}

        updated = r |> Run.changeset(attrs) |> Repo.update!()
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

  defp maybe_filter_project(q, pid) when is_integer(pid),
    do: from(r in q, where: r.project_id == ^pid)

  defp maybe_filter_q(q, nil), do: q
  defp maybe_filter_q(q, ""), do: q

  defp maybe_filter_q(q, text) when is_binary(text) do
    pattern = "%" <> String.downcase(text) <> "%"
    from(r in q, where: like(fragment("LOWER(?)", r.prompt), ^pattern))
  end

  defp clamp(n, lo, hi) when is_integer(n), do: n |> max(lo) |> min(hi)

  defp now_ms, do: System.os_time(:millisecond)

  # ---------------------------------------------------------------------------
  # Phase 7: State transitions
  # Each UPDATE uses a source-state guard so concurrent calls are idempotent.
  # ---------------------------------------------------------------------------

  @spec mark_starting_from_queued(integer(), String.t()) :: :ok
  def mark_starting_from_queued(id, container_id) do
    now = now_ms()

    Repo.update_all(
      from(r in Run,
        where: r.id == ^id and r.state == "queued"
      ),
      set: [state: "starting", container_id: container_id, started_at: now, state_entered_at: now]
    )

    :ok
  end

  @spec mark_awaiting_resume(integer(), %{
          next_resume_at: integer(),
          last_limit_reset_at: integer() | nil
        }) :: :ok
  def mark_awaiting_resume(id, %{next_resume_at: next_at, last_limit_reset_at: last_reset}) do
    now = now_ms()

    Repo.update_all(
      from(r in Run,
        where: r.id == ^id and r.state in ["starting", "running", "waiting"]
      ),
      inc: [resume_attempts: 1],
      set: [
        state: "awaiting_resume",
        container_id: nil,
        next_resume_at: next_at,
        last_limit_reset_at: last_reset,
        state_entered_at: now
      ]
    )

    :ok
  end

  @spec mark_starting_for_resume(integer(), String.t()) :: :ok
  def mark_starting_for_resume(id, container_id) do
    now = now_ms()

    Repo.update_all(
      from(r in Run,
        where: r.id == ^id and r.state == "awaiting_resume"
      ),
      set: [
        state: "starting",
        container_id: container_id,
        next_resume_at: nil,
        state_entered_at: now
      ]
    )

    Repo.update_all(
      from(r in Run, where: r.id == ^id and is_nil(r.started_at)),
      set: [started_at: now]
    )

    :ok
  end

  @spec mark_starting_for_continue_request(integer()) :: :ok
  def mark_starting_for_continue_request(id) do
    now = now_ms()

    Repo.update_all(
      from(r in Run,
        where: r.id == ^id and r.state in ["failed", "cancelled", "succeeded"]
      ),
      set: [
        state: "starting",
        resume_attempts: 0,
        next_resume_at: nil,
        finished_at: nil,
        exit_code: nil,
        error: nil,
        state_entered_at: now
      ]
    )

    :ok
  end

  @spec mark_starting_container(integer(), String.t()) :: :ok
  def mark_starting_container(id, container_id) do
    now = now_ms()

    Repo.update_all(
      from(r in Run, where: r.id == ^id and r.state == "starting"),
      set: [container_id: container_id, state_entered_at: now]
    )

    Repo.update_all(
      from(r in Run, where: r.id == ^id and is_nil(r.started_at)),
      set: [started_at: now]
    )

    :ok
  end

  @spec mark_waiting(integer()) :: :ok
  def mark_waiting(id) do
    Repo.update_all(
      from(r in Run, where: r.id == ^id and r.state in ["starting", "running"]),
      set: [state: "waiting", state_entered_at: now_ms()]
    )

    :ok
  end

  @spec mark_running(integer()) :: :ok
  def mark_running(id) do
    Repo.update_all(
      from(r in Run, where: r.id == ^id and r.state in ["starting", "waiting"]),
      set: [state: "running", state_entered_at: now_ms()]
    )

    :ok
  end

  @type finish_params :: %{
          state: String.t(),
          exit_code: integer() | nil,
          head_commit: String.t() | nil,
          branch_name: String.t() | nil,
          error: String.t() | nil
        }

  @spec mark_finished(integer(), finish_params()) :: :ok
  def mark_finished(id, params) do
    now = now_ms()

    base_set = [
      state: params.state,
      container_id: nil,
      exit_code: params.exit_code,
      head_commit: params.head_commit,
      error: params.error,
      finished_at: now,
      state_entered_at: now
    ]

    updates =
      case params[:branch_name] do
        nil -> base_set
        branch -> [{:branch_name, branch} | base_set]
      end

    Repo.update_all(from(r in Run, where: r.id == ^id), set: updates)
    :ok
  end

  @spec mark_resume_failed(integer(), String.t()) :: :ok
  def mark_resume_failed(id, error) do
    now = now_ms()

    Repo.update_all(
      from(r in Run, where: r.id == ^id),
      set: [
        state: "resume_failed",
        container_id: nil,
        error: error,
        finished_at: now,
        state_entered_at: now
      ]
    )

    :ok
  end

  @spec set_claude_session_id(integer(), String.t()) :: :ok
  def set_claude_session_id(id, session_id) do
    Repo.update_all(from(r in Run, where: r.id == ^id and is_nil(r.claude_session_id)),
      set: [claude_session_id: session_id]
    )

    :ok
  end

  @spec set_log_path(integer(), String.t()) :: :ok
  def set_log_path(id, log_path) do
    Repo.update_all(from(r in Run, where: r.id == ^id), set: [log_path: log_path])
    :ok
  end

  @spec set_branch_name(integer(), String.t()) :: :ok
  def set_branch_name(id, branch) do
    Repo.update_all(from(r in Run, where: r.id == ^id), set: [branch_name: branch])
    :ok
  end

  @spec set_mirror_status(integer(), String.t()) :: :ok
  def set_mirror_status(id, status) do
    Repo.update_all(from(r in Run, where: r.id == ^id), set: [mirror_status: status])
    :ok
  end

  @spec update_last_limit_reset_at(integer(), integer()) :: :ok
  def update_last_limit_reset_at(id, ts) do
    Repo.update_all(from(r in Run, where: r.id == ^id), set: [last_limit_reset_at: ts])
    :ok
  end

  @spec update_model_params(integer(), %{
          model: String.t() | nil,
          effort: String.t() | nil,
          subagent_model: String.t() | nil
        }) :: :ok
  def update_model_params(id, params) do
    Repo.update_all(
      from(r in Run, where: r.id == ^id),
      set: [model: params.model, effort: params.effort, subagent_model: params.subagent_model]
    )

    :ok
  end

  @spec list_by_parent(integer()) :: [decoded()]
  def list_by_parent(parent_id) do
    from(r in Run, where: r.parent_run_id == ^parent_id, order_by: [asc: r.id])
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec list_active_by_branch(integer(), String.t()) :: [decoded()]
  def list_active_by_branch(project_id, branch) do
    from(r in Run,
      where:
        r.project_id == ^project_id and r.branch_name == ^branch and
          r.state in ["queued", "starting", "running", "waiting"]
    )
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec list_awaiting() :: [%{id: integer(), next_resume_at: integer() | nil}]
  def list_awaiting do
    from(r in Run,
      where: r.state == "awaiting_resume",
      select: %{id: r.id, next_resume_at: r.next_resume_at}
    )
    |> Repo.all()
  end

  @spec list_by_state(String.t(), pos_integer()) :: [decoded()]
  def list_by_state(state, limit \\ 100) do
    from(r in Run, where: r.state == ^state, order_by: [desc: r.created_at], limit: ^limit)
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec create(map()) :: decoded()
  def create(attrs) do
    now = now_ms()

    params =
      Map.merge(
        %{
          state: "queued",
          created_at: now,
          state_entered_at: now,
          kind: "work"
        },
        attrs
      )

    run =
      %Run{}
      |> Run.changeset(params)
      |> Repo.insert!()

    decode(run)
  end

  @doc "Build the plain JSON-ready map for a run. All keys mirror TS exactly."
  @spec decode(Run.t()) :: map()
  def decode(%Run{} = r) do
    Map.take(r, [
      :id,
      :project_id,
      :prompt,
      :branch_name,
      :state,
      :container_id,
      :log_path,
      :exit_code,
      :error,
      :head_commit,
      :started_at,
      :finished_at,
      :created_at,
      :state_entered_at,
      :model,
      :effort,
      :subagent_model,
      :resume_attempts,
      :next_resume_at,
      :claude_session_id,
      :last_limit_reset_at,
      :tokens_input,
      :tokens_output,
      :tokens_cache_read,
      :tokens_cache_create,
      :tokens_total,
      :usage_parse_errors,
      :title,
      :title_locked,
      :parent_run_id,
      :kind,
      :kind_args_json,
      :mirror_status
    ])
  end
end
