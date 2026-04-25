# Elixir Idiom Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert five TS-shaped patterns in the FBI Elixir server into idiomatic BEAM/OTP code, recovering parallelism, removing latent process-leak risk, and eliminating production `Process.sleep` calls.

**Architecture:** Five independent fixes, each a focused commit. Group 1 is the HTTP layer (controller cleanup). Group 2 is the orchestrator runtime (process supervision). Group 3 is data atomicity. Each task lands separately and ships independently.

**Tech Stack:** Elixir 1.15+, Phoenix 1.8, Ecto + Ecto.Multi, OTP (Task, Process), Erlang `:gen_tcp`.

**Working tree:** `/workspace`. Branch: `fix/server-elixir-audit` (already pushed; HEAD `cedcb24`). Commit straight onto this branch.

**Conventions in this repo:**
- Tests in `server-elixir/test/<mirroring-lib-path>_test.exs`. Run with `mix test test/path/to/file_test.exs`. Format with `mix format`.
- Commits: `type(scope): subject` (`fix`, `feat`, `refactor`, `test`).
- Don't write multi-line `@moduledoc` unless genuinely non-obvious.

---

## Task 1: Parallelize the two `gh` calls in `/api/runs/:id/changes`

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/changes_controller.ex` `maybe_enrich_with_github/2` (around line 158-178 of the post-audit-fixes file)
- Test: `server-elixir/test/fbi_web/controllers/changes_controller_test.exs`

**Why:** TS uses `Promise.all([prForBranch, prChecks, compareBranch])` so the three gh CLI invocations run concurrently. Elixir runs `pr_for_branch` and `compare_branch` sequentially. Each `gh api` invocation is ~hundreds of ms; doing them serially doubles user-facing latency on the Changes tab.

The test file already has stub-driven coverage from I8 (`describe "GET /api/runs/:id/changes (real behavior)"`). We extend that.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe "GET /api/runs/:id/changes (real behavior)"` block in `server-elixir/test/fbi_web/controllers/changes_controller_test.exs`:

```elixir
test "issues pr_for_branch and compare_branch concurrently", %{conn: conn, run_id: run_id} do
  parent = self()

  Application.put_env(:fbi, :gh_cmd_adapter, fn args ->
    send(parent, {:gh_call, args, System.monotonic_time(:millisecond)})
    Process.sleep(80)
    cond do
      Enum.any?(args, &String.contains?(&1, "compare/")) ->
        {:ok, ~s|{"ahead_by": 0, "behind_by": 0, "merge_base_commit": {"sha": ""}, "commits": []}|}
      Enum.any?(args, &String.contains?(&1, "/pulls?")) ->
        {:ok, "[]"}
      true ->
        {:ok, "[]"}
    end
  end)

  start = System.monotonic_time(:millisecond)
  conn = get(conn, "/api/runs/#{run_id}/changes")
  elapsed = System.monotonic_time(:millisecond) - start
  assert json_response(conn, 200)

  # Two 80ms stubs run in parallel should finish in well under 160ms.
  assert elapsed < 140, "expected concurrent gh calls (<140ms), got #{elapsed}ms"

  # Both calls fired (order doesn't matter).
  assert_received {:gh_call, _args1, _t1}
  assert_received {:gh_call, _args2, _t2}
end
```

The 140ms threshold is loose enough to absorb test-runner noise but tight enough that sequential 80+80=160ms execution will fail.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/changes_controller_test.exs
```

Expected: the new test fails with `expected concurrent gh calls (<140ms), got 16Xms`.

- [ ] **Step 3: Replace the sequential calls with `Task.async` + `Task.await`**

In `server-elixir/lib/fbi_web/controllers/changes_controller.ex`, find the `case result do {repo, base_branch, branch} -> ...` arm in `maybe_enrich_with_github/2`. Replace the two sequential `case` blocks (currently `pr = case GH.pr_for_branch(...) do ...` and `{gh_commits, ahead_by, behind_by, merge_base_sha} = case GH.compare_branch(...) do ...`) with:

```elixir
{repo, base_branch, branch} ->
  pr_task = Task.async(fn -> GH.pr_for_branch(repo, branch) end)
  compare_task = Task.async(fn -> GH.compare_branch(repo, base_branch, branch) end)

  pr =
    case Task.await(pr_task, 10_000) do
      {:ok, v} -> v
      _ -> nil
    end

  {gh_commits, ahead_by, behind_by, merge_base_sha} =
    case Task.await(compare_task, 10_000) do
      {:ok, %{commits: c, ahead_by: a, behind_by: b, merge_base_sha: m}} ->
        {c, a, b, m}

      _ ->
        {[], 0, 0, ""}
    end

  # ...rest of the function body unchanged (gh_shas, filtered_safeguard, all_commits, gh_payload, branch_base, return tuple)
```

Leave everything below the two destructures alone.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/changes_controller_test.exs
```

Expected: 11 tests, 0 failures (10 pre-existing + the new one).

- [ ] **Step 5: Run the full suite**

```bash
cd /workspace/server-elixir && mix test
```

- [ ] **Step 6: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/changes_controller.ex \
        server-elixir/test/fbi_web/controllers/changes_controller_test.exs
git commit -m "perf(changes): run pr_for_branch + compare_branch concurrently via Task.async"
```

---

## Task 2: Replace bare `spawn/1` readers with `Task.async` in `RunServer`

**Files:**
- Modify: `server-elixir/lib/fbi/orchestrator/run_server.ex` (four call sites)

**Why:** Reader processes are spawned naked at lines 309, 405, 479, 526 with `spawn(fn -> read_stdout_loop(...) end)` and torn down with `Process.exit(reader_pid, :kill)` at lines 330, 426, 500. No link, no monitor. If a reader crashes mid-read, the RunServer doesn't notice. If the RunServer itself dies, the reader is orphaned. `Task.async` gives us an automatic link + monitor, and `Task.shutdown` cleanly terminates with normal exit semantics.

**Note on the four sites:** Three of them follow the same `reader_pid = spawn(...)` → `Process.exit(reader_pid, :kill)` pattern. The fourth (line 526) discards the pid (`_log_reader_pid = spawn(...)`) — read it carefully and check whether it's later cleaned up. If not, it's a true leak that this fix should also address.

- [ ] **Step 1: Read the file and locate exact context for all four sites**

```bash
grep -n "spawn(fn -> read_stdout_loop\|Process.exit(reader_pid" /workspace/server-elixir/lib/fbi/orchestrator/run_server.ex
```

Expected output: 4 spawn lines (309, 405, 479, 526) + 3 exit lines (330, 426, 500). Line 526 has no matching exit — verify by scanning ±20 lines for any cleanup of `_log_reader_pid`.

- [ ] **Step 2: Replace each `reader_pid = spawn(...)` with `Task.async` and each `Process.exit(reader_pid, :kill)` with `Task.shutdown(reader, :brutal_kill)`**

For each of the three paired sites (309/330, 405/426, 479/500) in `server-elixir/lib/fbi/orchestrator/run_server.ex`:

Change:

```elixir
reader_pid = spawn(fn -> read_stdout_loop(attach_socket, run_id, on_bytes) end)
```

to:

```elixir
reader = Task.async(fn -> read_stdout_loop(attach_socket, run_id, on_bytes) end)
```

And the corresponding teardown:

```elixir
Process.exit(reader_pid, :kill)
```

to:

```elixir
Task.shutdown(reader, :brutal_kill)
```

`:brutal_kill` mirrors the previous `:kill` semantics (no shutdown grace period). The `Task` is linked, so if the RunServer process dies, the reader will too. The Task's reference exists in the RunServer's mailbox after `await`/`shutdown`, so it must be drained — read on.

- [ ] **Step 3: Drain Task reply messages so they don't pollute the lifecycle**

`Task.async` sends `{ref, result}` and `{:DOWN, ref, ...}` messages back to the calling process. After `Task.shutdown`, both messages may already be in the mailbox. Add a flush after the shutdown to keep the lifecycle's mailbox clean:

For each of the three paired sites, after `Task.shutdown(reader, :brutal_kill)`, append:

```elixir
flush_task_messages(reader.ref)
```

And add the helper at the bottom of the module's private functions:

```elixir
defp flush_task_messages(ref) do
  receive do
    {^ref, _} -> flush_task_messages(ref)
    {:DOWN, ^ref, _, _, _} -> flush_task_messages(ref)
  after
    0 -> :ok
  end
end
```

This is non-blocking (`after 0`) — drains anything already pending.

- [ ] **Step 4: Handle the unmatched site at line 526**

Read 30 lines before and after line 526. If the spawn there has no matching `Process.exit` and the spawned reader runs until the socket closes naturally, that's still a leak risk if the lifecycle exits before the socket closes.

The safe transformation is the same: `Task.async` for the spawn, then before any return path that exits the lifecycle, `Task.shutdown(log_reader, :brutal_kill); flush_task_messages(log_reader.ref)`.

If you genuinely cannot identify the right teardown point (e.g., the function returns immediately and the reader is meant to run as a fire-and-forget tied to the socket's lifetime), STOP and report status `BLOCKED` with a description of the code shape — don't introduce a leak by guessing.

- [ ] **Step 5: Run the suite to confirm no regressions**

```bash
cd /workspace/server-elixir && mix test
```

The orchestrator-related tests (`test/fbi/orchestrator/run_server_test.exs` if present, plus run_server_lifecycle traces in other tests) should still pass. The pre-existing `RunServer lifecycle crashed: error :function_clause` log noise is unrelated and expected.

- [ ] **Step 6: Commit**

```bash
git add server-elixir/lib/fbi/orchestrator/run_server.ex
git commit -m "refactor(orchestrator): replace bare spawn readers with Task.async"
```

---

## Task 3: Rewrite `RunsController.do_create/8` with a `with` chain

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex` `do_create/8` (around lines 136-205 of post-audit-fixes file)
- Test: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`

**Why:** The current `try/rescue e -> 422 inspect(e)` masks every error type as `promotion_failed`-ish. A DB connection error and a draft-token regex mismatch return identical responses. A `with` chain makes each fallible step explicit and lets us return shape-appropriate errors.

The shape we want preserves all existing behavior (token validation 400, promotion failure 422 with rollback, success 201) but routes through tagged tuples instead of exceptions.

- [ ] **Step 1: Add a regression test that exercises the rollback path**

Append inside the existing `describe "POST /api/projects/:id/runs draft_token promotion"` block (or create a new describe block if needed) in `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`:

```elixir
test "rollback on promote failure: 422 + run row deleted + uploads dir cleaned", %{conn: conn} do
  draft_dir = Application.fetch_env!(:fbi, :draft_uploads_dir)
  runs_dir = Application.fetch_env!(:fbi, :runs_dir)

  # Use a syntactically-valid token that has NO directory on disk, so promote
  # will return {:error, :enoent}.
  token = "deadbeefdeadbeefdeadbeefdeadbeef"
  refute File.exists?(Path.join(draft_dir, token))

  {:ok, p} = FBI.Projects.Queries.create(%{
    name: "p-#{System.unique_integer([:positive])}",
    repo_url: "git@github.com:o/r.git",
    default_branch: "main"
  })

  before_count = FBI.Repo.aggregate(FBI.Runs.Run, :count, :id)

  conn = json_post(conn, "/api/projects/#{p.id}/runs", %{prompt: "x", draft_token: token})
  assert %{"error" => "promotion_failed"} = json_response(conn, 422)

  after_count = FBI.Repo.aggregate(FBI.Runs.Run, :count, :id)
  assert after_count == before_count, "rollback should have removed the inserted run row"
end
```

This may already be partially covered by Task 7's tests; add it only if not already present.

- [ ] **Step 2: Run the test, observe pass or fail**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

If the test passes today (the current `try/rescue` does perform rollback), good — we'll preserve that behavior through the refactor. If it fails, fix the existing code first before refactoring.

- [ ] **Step 3: Replace the body of `do_create/8`**

In `server-elixir/lib/fbi_web/controllers/runs_controller.ex`, find `do_create/8` (the one that currently has the `try/rescue` block). Replace the entire function body with:

```elixir
defp do_create(conn, project_id, params, prompt, branch_hint, model, effort, subagent_model) do
  runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")
  draft_dir = Application.fetch_env!(:fbi, :draft_uploads_dir)
  branch_name = if branch_hint && branch_hint != "", do: branch_hint, else: "main"
  token = params["draft_token"] || ""

  with :ok <- validate_draft_token(token),
       attrs = build_create_attrs(project_id, prompt, branch_name, model, effort, subagent_model),
       {:ok, run} <- create_run_with_log_path(attrs, runs_dir),
       :ok <- maybe_promote_draft(token, draft_dir, runs_dir, run.id) do
    FBI.Orchestrator.init_safeguard(run.id)
    FBI.Orchestrator.launch(run.id)
    conn |> put_status(201) |> json(run)
  else
    {:error, :invalid_token} ->
      conn |> put_status(400) |> json(%{error: "invalid_token"})

    {:error, {:promotion_failed, run_id}} ->
      Queries.delete(run_id)
      File.rm_rf(Path.join(runs_dir, Integer.to_string(run_id)))
      conn |> put_status(422) |> json(%{error: "promotion_failed"})

    {:error, reason} ->
      conn |> put_status(422) |> json(%{error: inspect(reason)})
  end
end

defp validate_draft_token(""), do: :ok

defp validate_draft_token(token) do
  if FBI.Uploads.Draft.valid_token?(token), do: :ok, else: {:error, :invalid_token}
end

defp build_create_attrs(project_id, prompt, branch_name, model, effort, subagent_model) do
  %{
    project_id: project_id,
    prompt: prompt,
    branch_name: branch_name,
    model: model,
    effort: effort,
    subagent_model: subagent_model,
    log_path: "_pending_",
    state: "queued"
  }
end

defp create_run_with_log_path(attrs, runs_dir) do
  run = Queries.create(attrs)
  log_path = Path.join(runs_dir, "#{run.id}.log")
  Queries.set_log_path(run.id, log_path)
  {:ok, %{run | log_path: log_path}}
end

defp maybe_promote_draft("", _draft_dir, _runs_dir, _run_id), do: :ok

defp maybe_promote_draft(token, draft_dir, runs_dir, run_id) do
  case FBI.Uploads.Draft.promote(draft_dir, runs_dir, token, run_id) do
    {:ok, _files} -> :ok
    :ok -> :ok
    {:error, _reason} -> {:error, {:promotion_failed, run_id}}
  end
end
```

The `{:error, {:promotion_failed, run_id}}` tuple carries the run_id forward to the rollback clause, which is what the original `try/rescue` got via closure-captured `run` variable. No more bare `try/rescue`.

Note: `create_run_with_log_path/2` doesn't use `Ecto.Multi` (Task 5 will). For now we keep the two-step write and accept the same partial-state window as before; this task is purely about replacing flow control.

- [ ] **Step 4: Run the test suite**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

Expected: all existing tests still pass plus the new one (if added).

- [ ] **Step 5: Run the full suite**

```bash
cd /workspace/server-elixir && mix test
```

- [ ] **Step 6: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/test/fbi_web/controllers/runs_controller_test.exs
git commit -m "refactor(runs): rewrite do_create with with-chain; drop try/rescue"
```

---

## Task 4: Replace `Process.sleep` in `LimitMonitor` callback with `send_after`

**Files:**
- Modify: `server-elixir/lib/fbi/orchestrator/run_server.ex` `start_limit_monitor/6` (around lines 799-820)

**Why:** `Process.sleep(500)` and `Process.sleep(30_000)` inside the `on_detect` callback block the calling process (the `LimitMonitor` GenServer that fires `on_detect`). While sleeping, the monitor can't process new ticks — it falls 500ms-30s behind on disk-fill checks for that run, and across many runs this compounds.

The fix is to fire the deferred actions through `Process.send_after(self(), msg, ms)` to a process that handles them in `handle_info`. The simplest target: a small dedicated handler process started alongside the limit monitor.

- [ ] **Step 1: Read the surrounding code**

```bash
sed -n '795,825p' /workspace/server-elixir/lib/fbi/orchestrator/run_server.ex
```

Confirm the current shape:

```elixir
defp start_limit_monitor(_run_id, mount_dir, container_id, attach_socket, settings, on_bytes) do
  {:ok, pid} =
    LimitMonitor.start_link(
      mount_dir: mount_dir,
      on_detect: fn ->
        if settings.auto_resume_enabled do
          :gen_tcp.send(attach_socket, <<3>>)
          Process.sleep(500)
          :gen_tcp.send(attach_socket, <<3>>)

          spawn(fn ->
            Process.sleep(30_000)
            FBI.Docker.stop_container(container_id, t: 5)
          end)

          on_bytes.("\n[fbi] limit detected; nudging Claude to exit\n")
        end
      end
    )

  pid
end
```

- [ ] **Step 2: Add a small worker module**

Create `server-elixir/lib/fbi/orchestrator/nudge_worker.ex`:

```elixir
defmodule FBI.Orchestrator.NudgeWorker do
  @moduledoc """
  Tiny GenServer that handles deferred limit-nudge actions without blocking
  the LimitMonitor. Receives `{:second_ctrlc, socket}` and `{:stop_container, container_id}`
  via `Process.send_after/3` and executes them on its own timer.
  """

  use GenServer

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, opts)
  end

  @spec schedule_second_ctrlc(GenServer.server(), port() | :inet.socket(), non_neg_integer()) :: :ok
  def schedule_second_ctrlc(server, socket, after_ms) do
    GenServer.cast(server, {:schedule_second_ctrlc, socket, after_ms})
  end

  @spec schedule_stop_container(GenServer.server(), String.t(), non_neg_integer()) :: :ok
  def schedule_stop_container(server, container_id, after_ms) do
    GenServer.cast(server, {:schedule_stop_container, container_id, after_ms})
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_cast({:schedule_second_ctrlc, socket, after_ms}, state) do
    Process.send_after(self(), {:second_ctrlc, socket}, after_ms)
    {:noreply, state}
  end

  def handle_cast({:schedule_stop_container, container_id, after_ms}, state) do
    Process.send_after(self(), {:stop_container, container_id}, after_ms)
    {:noreply, state}
  end

  @impl true
  def handle_info({:second_ctrlc, socket}, state) do
    _ = :gen_tcp.send(socket, <<3>>)
    {:noreply, state}
  end

  def handle_info({:stop_container, container_id}, state) do
    FBI.Docker.stop_container(container_id, t: 5)
    {:noreply, state}
  end
end
```

- [ ] **Step 3: Add a unit test for the worker**

Create `server-elixir/test/fbi/orchestrator/nudge_worker_test.exs`:

```elixir
defmodule FBI.Orchestrator.NudgeWorkerTest do
  use ExUnit.Case, async: true
  alias FBI.Orchestrator.NudgeWorker

  test "schedule_second_ctrlc sends to socket after delay" do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(listener)

    {:ok, client} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false])
    {:ok, server_sock} = :gen_tcp.accept(listener)

    {:ok, worker} = NudgeWorker.start_link()
    NudgeWorker.schedule_second_ctrlc(worker, client, 10)

    assert {:ok, <<3>>} = :gen_tcp.recv(server_sock, 1, 200)

    :gen_tcp.close(client)
    :gen_tcp.close(server_sock)
    :gen_tcp.close(listener)
  end

  test "schedule_stop_container is a no-op safety check" do
    {:ok, worker} = NudgeWorker.start_link()
    # Just verify the cast doesn't crash; the actual Docker call will fail in
    # the test env (no daemon) but that's caught inside `stop_container`.
    NudgeWorker.schedule_stop_container(worker, "nonexistent", 10)
    Process.sleep(50)
    assert Process.alive?(worker)
  end
end
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd /workspace/server-elixir && mix test test/fbi/orchestrator/nudge_worker_test.exs
```

- [ ] **Step 5: Wire the worker into `start_limit_monitor`**

Replace `start_limit_monitor/6` in `run_server.ex`:

```elixir
defp start_limit_monitor(_run_id, mount_dir, container_id, attach_socket, settings, on_bytes) do
  {:ok, nudge_worker} = FBI.Orchestrator.NudgeWorker.start_link()

  {:ok, pid} =
    LimitMonitor.start_link(
      mount_dir: mount_dir,
      on_detect: fn ->
        if settings.auto_resume_enabled do
          :gen_tcp.send(attach_socket, <<3>>)
          FBI.Orchestrator.NudgeWorker.schedule_second_ctrlc(nudge_worker, attach_socket, 500)
          FBI.Orchestrator.NudgeWorker.schedule_stop_container(nudge_worker, container_id, 30_000)

          on_bytes.("\n[fbi] limit detected; nudging Claude to exit\n")
        end
      end
    )

  pid
end
```

The worker is started once per LimitMonitor and lives until process tree teardown. (It's not added to the supervision tree explicitly because it's process-tied to the run lifecycle; if the RunServer dies, the worker dies with it via the lifecycle task's exit. If you want stricter supervision, add it to the run-server's tracked pids alongside the watchers — that's Task 4.5 territory and not required here.)

- [ ] **Step 6: Run the suite**

```bash
cd /workspace/server-elixir && mix test
```

- [ ] **Step 7: Commit**

```bash
git add server-elixir/lib/fbi/orchestrator/nudge_worker.ex \
        server-elixir/test/fbi/orchestrator/nudge_worker_test.exs \
        server-elixir/lib/fbi/orchestrator/run_server.ex
git commit -m "refactor(orchestrator): NudgeWorker replaces Process.sleep in LimitMonitor cb"
```

---

## Task 5: Wrap `create + set_log_path` in `Ecto.Multi.transaction`

**Files:**
- Modify: `server-elixir/lib/fbi/runs/queries.ex` — add `create_with_log_path/2`
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex` `do_create/8` (now uses the new helper from Task 3's `create_run_with_log_path/2`)
- Test: `server-elixir/test/fbi/runs/queries_test.exs`

**Why:** The current sequence — `Queries.create/1` then `Queries.set_log_path/2` — is two non-atomic writes. A crash between them leaves a row with `log_path = "_pending_"`. SQLite supports transactions; `Ecto.Multi` is the idiomatic way.

This task assumes Task 3 has landed (so we have `create_run_with_log_path/2` in the controller). We push the actual DB work down into the queries module and make it atomic.

- [ ] **Step 1: Add the failing test**

Append to `server-elixir/test/fbi/runs/queries_test.exs`:

```elixir
test "create_with_log_path/2 inserts run + sets log_path atomically" do
  {:ok, p} =
    FBI.Projects.Queries.create(%{
      name: "p-#{System.unique_integer([:positive])}",
      repo_url: "git@github.com:o/r.git",
      default_branch: "main"
    })

  attrs = %{
    project_id: p.id,
    prompt: "x",
    branch_name: "feat",
    state: "queued",
    log_path: "_pending_"
  }

  log_path_fn = fn id -> "/tmp/fbi-runs/#{id}.log" end

  assert {:ok, run} = FBI.Runs.Queries.create_with_log_path(attrs, log_path_fn)
  assert run.log_path == "/tmp/fbi-runs/#{run.id}.log"

  # The DB row reflects the final log_path, not the placeholder.
  {:ok, fresh} = FBI.Runs.Queries.get(run.id)
  assert fresh.log_path == "/tmp/fbi-runs/#{run.id}.log"
end
```

- [ ] **Step 2: Run, confirm fail (function missing)**

```bash
cd /workspace/server-elixir && mix test test/fbi/runs/queries_test.exs
```

- [ ] **Step 3: Add `create_with_log_path/2` to `lib/fbi/runs/queries.ex`**

Insert near `create/1` and `set_log_path/2` (around line 415):

```elixir
@doc """
Insert a run row and set its `log_path` atomically. The caller provides a
function `id -> path` so the path can reference the freshly-inserted id.
"""
@spec create_with_log_path(map(), (integer() -> String.t())) ::
        {:ok, decoded()} | {:error, term()}
def create_with_log_path(attrs, log_path_fn) when is_function(log_path_fn, 1) do
  now = now_ms()

  params =
    Map.merge(
      %{state: "queued", created_at: now, state_entered_at: now, kind: "work"},
      attrs
    )

  result =
    Ecto.Multi.new()
    |> Ecto.Multi.insert(:run, Run.changeset(%Run{}, params))
    |> Ecto.Multi.update_all(:set_log_path, fn %{run: r} ->
      from(x in Run, where: x.id == ^r.id, update: [set: [log_path: ^log_path_fn.(r.id)]])
    end, [])
    |> Repo.transaction()

  case result do
    {:ok, %{run: r}} ->
      {:ok, decode(%{r | log_path: log_path_fn.(r.id)})}

    {:error, _step, reason, _changes} ->
      {:error, reason}
  end
end
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd /workspace/server-elixir && mix test test/fbi/runs/queries_test.exs
```

- [ ] **Step 5: Switch the controller to use it**

In `lib/fbi_web/controllers/runs_controller.ex`, replace the body of `create_run_with_log_path/2` (added in Task 3) with a delegation:

```elixir
defp create_run_with_log_path(attrs, runs_dir) do
  Queries.create_with_log_path(attrs, fn id -> Path.join(runs_dir, "#{id}.log") end)
end
```

The function signature and return shape stay the same (`{:ok, run} | {:error, _}`), so the `with` chain in `do_create/8` doesn't need changes.

- [ ] **Step 6: Run the full suite**

```bash
cd /workspace/server-elixir && mix test
```

- [ ] **Step 7: Commit**

```bash
git add server-elixir/lib/fbi/runs/queries.ex \
        server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/test/fbi/runs/queries_test.exs
git commit -m "feat(runs): create_with_log_path/2 makes insert+log_path atomic via Ecto.Multi"
```

---

## Task 6: Final format + full-suite check

- [ ] **Step 1: Format**

```bash
cd /workspace/server-elixir && mix format
```

- [ ] **Step 2: Full suite**

```bash
cd /workspace/server-elixir && mix test
```

Expected: 495+ tests, 0 failures.

- [ ] **Step 3: If formatter touched anything, commit**

```bash
git add -A server-elixir/
git diff --cached --stat
git commit -m "style(server-elixir): mix format" # only if formatter produced changes
```

---

## Self-review checklist

- [x] Each step fits 2-5 minutes per step.
- [x] All `file:line` references match the post-audit-fixes branch (`cedcb24` HEAD on `fix/server-elixir-audit`).
- [x] No "TODO" or "similar to Task N" placeholders.
- [x] Cross-task contracts: Task 5's `create_with_log_path/2` returns `{:ok, decoded()} | {:error, _}`; Task 3's `create_run_with_log_path/2` adapts to that. Both consume the same `runs_dir` arg.
- [x] All five Explore-flagged anti-patterns are mapped: T1 (gh parallelism) → I1 in original audit; T2 (bare spawn) → I2; T3 (try/rescue) → I3; T4 (Process.sleep) → I4; T5 (Ecto.Multi atomicity) → I5.
- [x] Tasks are ordered so dependencies flow forward — T3 lands `create_run_with_log_path/2` as a controller helper; T5 swaps its body to delegate to a new queries helper.
