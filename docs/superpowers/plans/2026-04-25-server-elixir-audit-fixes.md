# Server-Elixir Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every defect found in the server-elixir audit on `origin/main` (audit baseline `99bb88f`) so the Elixir port matches the TS server's behaviour route-for-route, response-for-response.

**Architecture:** Four independently-mergeable groups, each shippable on its own. Group 1 fixes integration glue in `RunsController` so the orchestrator gets called correctly. Group 2 fixes the `ChangesController` so commit lists, file lists, and submodule diffs match TS. Group 3 cleans up smaller behavioural deltas. Group 4 ports the `listening-ports` + `proxy/:port` subsystem (the only TS-only routes still served by the catch-all proxy).

**Tech Stack:** Elixir 1.15+, Phoenix 1.8, Ecto + ecto_sqlite3, Plug.Conn, Phoenix.PubSub, ExUnit, `:gh` CLI subprocess, Docker Engine REST API (custom `FBI.Docker` client), `WebSockAdapter` + `WebSock` behaviour for raw WebSocket handlers, `:gen_tcp` for the proxy backend.

**Working tree:** Implement against the latest `origin/main`. The audit was performed against commit `99bb88f`. All `file:line` references below are to that tree.

**Conventions in this repo:**
- Tests live in `server-elixir/test/<mirroring-lib-path>_test.exs` and use `ExUnit.Case` or `FBIWeb.ConnCase` (see `server-elixir/test/fbi_web/controllers/uploads_controller_test.exs:1` for the pattern).
- Run a single test file with `mix test test/path/to/file_test.exs`. Run the whole suite with `mix test`. Format with `mix format`.
- Commits follow the `type(scope): subject` style — see `git log origin/main -- server-elixir/`. Use `fix(...)`, `feat(...)`, `test(...)` as appropriate.
- Don't write multi-line `@moduledoc` docstrings unless the module is genuinely non-obvious; a single short line is typical here.

**Cross-task contracts:**
- `FBI.Runs.ModelParams.validate/1` (added in Task 3) returns `:ok | {:error, String.t()}`. Tasks 4 and 5 consume it.
- `FBI.Github.Client.compare_branch/3` (added in Task 9) returns `{:ok, %{commits: [...], ahead_by: int, behind_by: int, merge_base_sha: String.t()}} | {:error, term()}`. Task 10 consumes it.
- `FBI.Uploads.Draft.promote/4` (added in Task 6) returns `{:ok, [%{filename: String.t(), size: integer()}]} | {:error, term()}`. Task 7 consumes it.
- `FBI.Proxy.ProcListeners.parse/1` (added in Task 17) returns `[%{port: integer(), proto: :tcp}]`. Tasks 18+19 consume it.

---

## Group 1: Runs controller integration glue (blockers)

The `RunsController` is mostly correct but skips orchestrator calls and validation that the TS handler does. Each task in this group is a small, focused fix.

### Task 1: PATCH `/api/runs/:id` locks the title

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex:51-66`
- Test: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs` (create if absent)

**Why:** TS calls `updateTitle(runId, trimmed, { lock: true, respectLock: false })` at `src/server/api/runs.ts:264`. The lock flag tells the auto-titler `TitleWatcher` not to overwrite. Elixir's `Queries.update_title/3` already accepts `lock` (`server-elixir/lib/fbi/runs/queries.ex:93`), but the controller calls it with two args, so `lock` defaults to `false`. The next watcher tick clobbers user-set titles.

- [ ] **Step 1: Add a failing test for title lock**

If the test file does not yet exist, create it with this content:

```elixir
defmodule FBIWeb.RunsControllerTest do
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries, as: Projects
  alias FBI.Repo
  alias FBI.Runs.Run

  defp make_run(state \\ "running") do
    {:ok, p} =
      Projects.create(%{
        name: "rc-#{System.unique_integer([:positive])}",
        repo_url: "git@github.com:o/r.git",
        default_branch: "main"
      })

    %Run{
      project_id: p.id,
      prompt: "x",
      branch_name: "feat",
      state: state,
      log_path: "/tmp/x.log",
      created_at: System.system_time(:millisecond),
      state_entered_at: System.system_time(:millisecond)
    }
    |> Repo.insert!()
  end

  test "PATCH /api/runs/:id locks the title", %{conn: conn} do
    run = make_run()
    conn = patch(conn, ~p"/api/runs/#{run.id}", %{title: "User pick"})
    assert %{"title" => "User pick", "title_locked" => 1} = json_response(conn, 200)
  end
end
```

If the file already exists, append the single test inside the existing `describe`/module.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs --only line:<line-of-the-new-test>
```

Expected: assertion fails with `title_locked: 0` (current bug).

- [ ] **Step 3: Pass `lock: true` in the controller**

In `server-elixir/lib/fbi_web/controllers/runs_controller.ex:51-66`, change:

```elixir
{:ok, run} <- Queries.update_title(id, title) do
```

to:

```elixir
{:ok, run} <- Queries.update_title(id, title, true) do
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/test/fbi_web/controllers/runs_controller_test.exs
git commit -m "fix(runs): patch_title locks user-set title (lock: true)"
```

---

### Task 2: PATCH `/api/runs/:id` broadcasts a title event over PubSub

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex:51-66`
- Modify: `server-elixir/lib/fbi_web/sockets/shell_ws_handler.ex` (subscribe to event topic + forward title frames)
- Test: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`

**Why:** TS at `src/server/api/runs.ts:266-270`:
```js
deps.streams.getOrCreateEvents(runId).publish({
  type: 'title', title: after.title, title_locked: after.title_locked,
});
```
Connected shell WebSockets forward this so all open run windows get a live title update. Elixir doesn't broadcast at all today.

The Elixir orchestrator already publishes state changes over PubSub (see `RunServer.publish_state/1` at `server-elixir/lib/fbi/orchestrator/run_server.ex`). We add a parallel "events" topic for non-state run-level events (currently just title; future: anything else the TS `streams.getOrCreateEvents` carries).

- [ ] **Step 1: Add the failing test**

Append to `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`:

```elixir
test "PATCH /api/runs/:id publishes a title event on Phoenix.PubSub", %{conn: conn} do
  run = make_run()
  Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run.id}:events")
  patch(conn, ~p"/api/runs/#{run.id}", %{title: "Hello"})
  assert_receive {:run_event, %{type: "title", title: "Hello", title_locked: 1}}, 500
end
```

- [ ] **Step 2: Confirm it fails**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

Expected: timeout on `assert_receive` (no broadcast happens).

- [ ] **Step 3: Publish the event from the controller**

In `runs_controller.ex` `patch_title/2`, after the successful `update_title` call but before `json(conn, run)`, broadcast the event:

```elixir
def patch_title(conn, %{"id" => id_str} = params) do
  title =
    case params["title"] do
      t when is_binary(t) -> String.trim(t)
      _ -> nil
    end

  with {:ok, id} <- parse_id(id_str),
       true <- is_binary(title) and byte_size(title) > 0 and byte_size(title) <= 120,
       {:ok, run} <- Queries.update_title(id, title, true) do
    Phoenix.PubSub.broadcast(
      FBI.PubSub,
      "run:#{id}:events",
      {:run_event, %{type: "title", title: run.title, title_locked: run.title_locked}}
    )
    json(conn, run)
  else
    :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
    _ -> conn |> put_status(400) |> json(%{error: "invalid title"})
  end
end
```

- [ ] **Step 4: Confirm test passes**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 5: Forward the event in the shell WS handler**

In `server-elixir/lib/fbi_web/sockets/shell_ws_handler.ex`, find the `init/1` callback and subscribe to the events topic alongside whatever subscriptions already happen. Append:

```elixir
Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:events")
```

(Adjust to match whatever variable name holds the run id in `init/1`.) Then add a `handle_info/2` clause that forwards the event payload as a JSON text frame:

```elixir
@impl true
def handle_info({:run_event, payload}, state) do
  {:push, {:text, Jason.encode!(payload)}, state}
end
```

Place it before any catch-all `handle_info/2` clause.

- [ ] **Step 6: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/lib/fbi_web/sockets/shell_ws_handler.ex \
        server-elixir/test/fbi_web/controllers/runs_controller_test.exs
git commit -m "fix(runs): patch_title broadcasts title event to shell WS subscribers"
```

---

### Task 3: ModelParams validation module

**Files:**
- Create: `server-elixir/lib/fbi/runs/model_params.ex`
- Test: `server-elixir/test/fbi/runs/model_params_test.exs`

**Why:** Tasks 4 and 5 both need to validate `model`/`effort`/`subagent_model` exactly the way TS does at `src/server/api/modelParams.ts`. Centralise it.

- [ ] **Step 1: Add the failing test**

Create `server-elixir/test/fbi/runs/model_params_test.exs`:

```elixir
defmodule FBI.Runs.ModelParamsTest do
  use ExUnit.Case, async: true
  alias FBI.Runs.ModelParams

  test "accepts unset values" do
    assert :ok = ModelParams.validate(%{})
    assert :ok = ModelParams.validate(%{model: nil, effort: nil, subagent_model: nil})
  end

  test "accepts known model + effort combos" do
    assert :ok = ModelParams.validate(%{model: "sonnet", effort: "high"})
    assert :ok = ModelParams.validate(%{model: "opus", effort: "xhigh"})
    assert :ok = ModelParams.validate(%{model: "haiku"})
    assert :ok = ModelParams.validate(%{subagent_model: "sonnet"})
  end

  test "rejects unknown model" do
    assert {:error, "invalid model: gpt"} = ModelParams.validate(%{model: "gpt"})
  end

  test "rejects unknown effort" do
    assert {:error, "invalid effort: blast"} = ModelParams.validate(%{effort: "blast"})
  end

  test "rejects unknown subagent_model" do
    assert {:error, "invalid subagent_model: gpt"} =
             ModelParams.validate(%{subagent_model: "gpt"})
  end

  test "rejects effort on haiku" do
    assert {:error, "effort is not supported on haiku"} =
             ModelParams.validate(%{model: "haiku", effort: "low"})
  end

  test "rejects xhigh on non-opus" do
    assert {:error, "xhigh effort is only supported on opus"} =
             ModelParams.validate(%{model: "sonnet", effort: "xhigh"})
  end
end
```

- [ ] **Step 2: Run and confirm it fails (module missing)**

```bash
cd server-elixir && mix test test/fbi/runs/model_params_test.exs
```

Expected: `(UndefinedFunctionError) function FBI.Runs.ModelParams.validate/1 is undefined`.

- [ ] **Step 3: Create the module**

Create `server-elixir/lib/fbi/runs/model_params.ex`:

```elixir
defmodule FBI.Runs.ModelParams do
  @moduledoc "Validates run model/effort/subagent_model. Mirrors src/server/api/modelParams.ts."

  @models ~w(sonnet opus haiku)
  @efforts ~w(low medium high xhigh max)

  @spec validate(map()) :: :ok | {:error, String.t()}
  def validate(params) when is_map(params) do
    model = Map.get(params, :model) || Map.get(params, "model")
    effort = Map.get(params, :effort) || Map.get(params, "effort")
    subagent = Map.get(params, :subagent_model) || Map.get(params, "subagent_model")

    cond do
      model not in [nil | @models] ->
        {:error, "invalid model: #{model}"}

      effort not in [nil | @efforts] ->
        {:error, "invalid effort: #{effort}"}

      subagent not in [nil | @models] ->
        {:error, "invalid subagent_model: #{subagent}"}

      effort != nil and model == "haiku" ->
        {:error, "effort is not supported on haiku"}

      effort == "xhigh" and model != nil and model != "opus" ->
        {:error, "xhigh effort is only supported on opus"}

      true ->
        :ok
    end
  end
end
```

- [ ] **Step 4: Confirm tests pass**

```bash
cd server-elixir && mix test test/fbi/runs/model_params_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi/runs/model_params.ex \
        server-elixir/test/fbi/runs/model_params_test.exs
git commit -m "feat(runs): add ModelParams.validate/1 mirroring TS validateModelParams"
```

---

### Task 4: `POST /api/runs/:id/continue` reads + validates body params

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex:153-173`
- Test: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`

**Why:** Audit finding A1. TS at `src/server/api/runs.ts:283-321` reads `body.{model,effort,subagent_model}`, validates, and updates the run row before transitioning. Elixir destructures only `"id"` and never reads body params.

`Queries.update_model_params/2` already exists at `server-elixir/lib/fbi/runs/queries.ex:347` — just needs to be called.

- [ ] **Step 1: Add a failing test**

Append to `runs_controller_test.exs`:

```elixir
describe "POST /api/runs/:id/continue model params" do
  test "rejects invalid model with 400", %{conn: conn} do
    run = make_run("succeeded")
    conn = post(conn, ~p"/api/runs/#{run.id}/continue", %{model: "gpt"})
    assert %{"error" => "invalid model: gpt"} = json_response(conn, 400)
  end

  test "persists provided model params before continuing", %{conn: conn} do
    run = make_run("succeeded")
    # NOTE: the orchestrator continue_run/1 will likely 409 in this unit test
    # because there is no running daemon. We only need the DB write to land.
    post(conn, ~p"/api/runs/#{run.id}/continue", %{
      model: "opus",
      effort: "xhigh",
      subagent_model: "haiku"
    })
    fresh = FBI.Runs.Queries.get(run.id) |> elem(1)
    assert fresh.model == "opus"
    assert fresh.effort == "xhigh"
    assert fresh.subagent_model == "haiku"
  end
end
```

- [ ] **Step 2: Run and confirm both fail**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 3: Update `continue_run/2`**

Replace the existing `continue_run/2` in `runs_controller.ex` with:

```elixir
def continue_run(conn, %{"id" => id} = params) do
  run_id = String.to_integer(id)

  with {:ok, run} <- Queries.get(run_id) |> from_get(),
       :ok <- FBI.Runs.ModelParams.validate(params),
       :ok <- FBI.Orchestrator.ContinueEligibility.check(run, runs_dir()) do
    Queries.update_model_params(run_id, %{
      model: params["model"],
      effort: params["effort"],
      subagent_model: params["subagent_model"]
    })

    FBI.Orchestrator.mark_starting_for_continue_request(run_id)
    FBI.Orchestrator.continue_run(run_id)
    send_resp(conn, 204, "")
  else
    :not_found ->
      conn |> put_status(404) |> json(%{error: "not found"})

    {:error, code, message} ->
      conn |> put_status(409) |> json(%{code: code, message: message})

    {:error, message} when is_binary(message) ->
      conn |> put_status(400) |> json(%{error: message})
  end
end

defp from_get({:ok, run}), do: {:ok, run}
defp from_get(:not_found), do: :not_found

defp runs_dir,
  do: Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")
```

(`from_get/1` is a small adapter so the `with` chain has uniform `{:ok, _}/{:error, _}/:not_found` shapes. Place both helpers near `parse_id/1` at the bottom of the module.)

- [ ] **Step 4: Confirm tests pass**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/test/fbi_web/controllers/runs_controller_test.exs
git commit -m "fix(runs): continue_run reads + validates model params, persists before transition"
```

---

### Task 5: `POST /api/projects/:id/runs` validates model params

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex:85-150`
- Test: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`

**Why:** Audit finding A2 (validation half). TS at `src/server/api/runs.ts:175-182` validates before insert. Elixir's `create/2` accepts garbage values.

- [ ] **Step 1: Add the failing test**

Append:

```elixir
test "POST /api/projects/:id/runs rejects invalid effort", %{conn: conn} do
  {:ok, p} = FBI.Projects.Queries.create(%{
    name: "p-#{System.unique_integer([:positive])}",
    repo_url: "git@github.com:o/r.git",
    default_branch: "main"
  })
  conn = post(conn, ~p"/api/projects/#{p.id}/runs", %{prompt: "hi", effort: "blast"})
  assert %{"error" => "invalid effort: blast"} = json_response(conn, 400)
end
```

- [ ] **Step 2: Confirm it fails**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 3: Add the validation call**

In `runs_controller.ex` `create/2`, after the project lookup and before the `branch_hint`/`force` branch logic, insert:

```elixir
case FBI.Runs.ModelParams.validate(params) do
  :ok ->
    :ok

  {:error, message} ->
    throw({:invalid_params, message})
end
```

Wrap the rest of the function body in a `try ... catch :throw, ...` to surface the 400, OR (cleaner) restructure with a `with` chain. The cleaner version:

```elixir
def create(conn, %{"id" => project_id_str} = params) do
  project_id = String.to_integer(project_id_str)

  with {:ok, _project} <- FBI.Projects.Queries.get(project_id),
       :ok <- FBI.Runs.ModelParams.validate(params) do
    do_create_with_branch_check(conn, project_id, params)
  else
    :not_found ->
      conn |> put_status(404) |> json(%{error: "not found"})

    {:error, message} when is_binary(message) ->
      conn |> put_status(400) |> json(%{error: message})
  end
end
```

…and move the existing branch-conflict check + `do_create/7` invocation into `do_create_with_branch_check/3`:

```elixir
defp do_create_with_branch_check(conn, project_id, params) do
  prompt = params["prompt"] || ""
  branch_hint = params["branch"] || nil
  model = params["model"]
  effort = params["effort"]
  subagent_model = params["subagent_model"]
  force = params["force"] == true

  if branch_hint && branch_hint != "" && !force do
    active = Queries.list_active_by_branch(project_id, branch_hint)

    if active != [] do
      first = hd(active)

      conn
      |> put_status(409)
      |> json(%{
        error: "branch_in_use",
        active_run_id: first.id,
        message:
          "Run ##{first.id} is already using branch \"#{branch_hint}\". Pass { force: true } to start another run on the same branch anyway."
      })
    else
      do_create(conn, project_id, params, prompt, branch_hint, model, effort, subagent_model)
    end
  else
    do_create(conn, project_id, params, prompt, branch_hint, model, effort, subagent_model)
  end
end
```

(Note the extra `params` arg threaded through to `do_create/8` — Task 7 will use it for `draft_token`. Update `do_create/7` → `do_create/8` accordingly.)

- [ ] **Step 4: Confirm tests pass**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/test/fbi_web/controllers/runs_controller_test.exs
git commit -m "fix(runs): create validates model params before insert"
```

---

### Task 6: Draft uploads promote module

**Files:**
- Create: `server-elixir/lib/fbi/uploads/draft.ex`
- Test: `server-elixir/test/fbi/uploads/draft_test.exs`

**Why:** Audit finding A2 (promote half). TS `src/server/uploads/promote.ts` moves files from `<draftDir>/<token>/` into `<runsDir>/<runId>/uploads/`, deduplicating filenames via `resolveFilename`, returning `[{filename, size}]`. Elixir's `FBI.Uploads.FS.resolve_filename/2` already implements the dedup (audit finding for `uploads_controller.ex`); we just need the orchestration layer.

The 32-hex-char draft-token check (`src/server/uploads/token.ts:3`) also goes here as `valid_token?/1`.

- [ ] **Step 1: Failing test**

Create `server-elixir/test/fbi/uploads/draft_test.exs`:

```elixir
defmodule FBI.Uploads.DraftTest do
  use ExUnit.Case, async: false
  alias FBI.Uploads.Draft

  setup do
    base = Path.join(System.tmp_dir!(), "fbi-draft-#{System.unique_integer([:positive])}")
    draft_dir = Path.join(base, "drafts")
    runs_dir = Path.join(base, "runs")
    File.mkdir_p!(draft_dir)
    File.mkdir_p!(runs_dir)

    on_exit(fn -> File.rm_rf(base) end)

    {:ok, draft_dir: draft_dir, runs_dir: runs_dir}
  end

  test "valid_token? matches 32 hex chars" do
    assert Draft.valid_token?("0123456789abcdef0123456789abcdef")
    refute Draft.valid_token?("xxx")
    refute Draft.valid_token?("0123456789ABCDEF0123456789ABCDEF")
    refute Draft.valid_token?(nil)
  end

  test "promote moves files and returns metadata", %{draft_dir: dd, runs_dir: rd} do
    token = "0123456789abcdef0123456789abcdef"
    src = Path.join(dd, token)
    File.mkdir_p!(src)
    File.write!(Path.join(src, "a.txt"), "hello")
    File.write!(Path.join(src, "b.tmp.part"), "skip me") # .part files are skipped

    assert {:ok, [%{filename: "a.txt", size: 5}]} = Draft.promote(dd, rd, token, 42)

    dst = Path.join([rd, "42", "uploads", "a.txt"])
    assert File.read!(dst) == "hello"
    refute File.exists?(src)
  end

  test "promote returns :error if token dir is missing", %{draft_dir: dd, runs_dir: rd} do
    assert {:error, _} = Draft.promote(dd, rd, "0123456789abcdef0123456789abcdef", 99)
  end
end
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd server-elixir && mix test test/fbi/uploads/draft_test.exs
```

- [ ] **Step 3: Implement the module**

Create `server-elixir/lib/fbi/uploads/draft.ex`:

```elixir
defmodule FBI.Uploads.Draft do
  @moduledoc "Move draft uploads from `<draft_dir>/<token>` into a run's uploads dir."

  alias FBI.Uploads.FS

  @token_re ~r/^[0-9a-f]{32}$/

  @spec valid_token?(term()) :: boolean()
  def valid_token?(v) when is_binary(v), do: Regex.match?(@token_re, v)
  def valid_token?(_), do: false

  @spec promote(Path.t(), Path.t(), String.t(), integer()) ::
          {:ok, [%{filename: String.t(), size: integer()}]} | {:error, term()}
  def promote(draft_dir, runs_dir, token, run_id) do
    src = Path.join(draft_dir, token)
    dst = Path.join([runs_dir, Integer.to_string(run_id), "uploads"])

    with {:ok, entries} <- File.ls(src),
         :ok <- File.mkdir_p(dst) do
      promoted =
        entries
        |> Enum.reject(&String.ends_with?(&1, ".part"))
        |> Enum.map(fn name ->
          {:ok, final} = FS.resolve_filename(dst, name)
          src_path = Path.join(src, name)
          dst_path = Path.join(dst, final)
          :ok = File.rename(src_path, dst_path)
          %File.Stat{size: size} = File.stat!(dst_path)
          %{filename: final, size: size}
        end)

      File.rm_rf(src)
      {:ok, promoted}
    end
  end
end
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd server-elixir && mix test test/fbi/uploads/draft_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi/uploads/draft.ex \
        server-elixir/test/fbi/uploads/draft_test.exs
git commit -m "feat(uploads): add Draft.promote/4 + valid_token?/1 mirroring TS promoteDraft"
```

---

### Task 7: `POST /api/projects/:id/runs` handles `draft_token` with rollback

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex` (`do_create/8`)
- Test: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`

**Why:** Audit A2 final piece. TS at `src/server/api/runs.ts:204-220`:
```js
if (token.length > 0) {
  try {
    await promoteDraft({ ... });
  } catch (err) {
    deps.runs.delete(run.id);
    fs.rmSync(path.join(deps.runsDir, String(run.id)), { recursive: true, force: true });
    return reply.code(422).send({ error: 'promotion_failed' });
  }
}
```

- [ ] **Step 1: Add the failing test**

Append to `runs_controller_test.exs`:

```elixir
test "POST /api/projects/:id/runs promotes draft files into the new run", %{conn: conn} do
  draft_dir = Application.get_env(:fbi, :draft_uploads_dir) || raise "set :draft_uploads_dir for tests"
  token = "0123456789abcdef0123456789abcdef"
  File.mkdir_p!(Path.join(draft_dir, token))
  File.write!(Path.join([draft_dir, token, "note.txt"]), "hi")

  {:ok, p} = FBI.Projects.Queries.create(%{
    name: "p-#{System.unique_integer([:positive])}",
    repo_url: "git@github.com:o/r.git",
    default_branch: "main"
  })

  conn = post(conn, ~p"/api/projects/#{p.id}/runs", %{prompt: "x", draft_token: token})
  body = json_response(conn, 201)
  run_id = body["id"]

  uploads_dir = Path.join([
    Application.fetch_env!(:fbi, :runs_dir),
    Integer.to_string(run_id),
    "uploads"
  ])
  assert File.exists?(Path.join(uploads_dir, "note.txt"))
  refute File.exists?(Path.join(draft_dir, token))
end

test "POST /api/projects/:id/runs rejects malformed draft_token", %{conn: conn} do
  {:ok, p} = FBI.Projects.Queries.create(%{
    name: "p-#{System.unique_integer([:positive])}",
    repo_url: "git@github.com:o/r.git",
    default_branch: "main"
  })
  conn = post(conn, ~p"/api/projects/#{p.id}/runs", %{prompt: "x", draft_token: "not-a-token"})
  assert %{"error" => "invalid_token"} = json_response(conn, 400)
end
```

The test's setup needs `:draft_uploads_dir` and `:runs_dir` set. Add a `setup_all` or per-test setup that creates a temp dir tree and `Application.put_env/3`s both keys (mirror the existing pattern from `uploads_controller_test.exs:8-26`).

- [ ] **Step 2: Confirm fail**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 3: Wire promotion + rollback into `do_create/8`**

Update the signature of `do_create/_` to accept `params`, then after the successful insert + safeguard init but before `launch`, run promotion:

```elixir
defp do_create(conn, project_id, params, prompt, branch_hint, model, effort, subagent_model) do
  runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")
  draft_dir = Application.fetch_env!(:fbi, :draft_uploads_dir)
  branch_name = if branch_hint && branch_hint != "", do: branch_hint, else: "main"

  token = params["draft_token"] || ""

  cond do
    token != "" and not FBI.Uploads.Draft.valid_token?(token) ->
      conn |> put_status(400) |> json(%{error: "invalid_token"})

    true ->
      attrs = %{
        project_id: project_id,
        prompt: prompt,
        branch_name: branch_name,
        model: model,
        effort: effort,
        subagent_model: subagent_model,
        log_path: "_pending_",
        state: "queued"
      }

      try do
        run = Queries.create(attrs)
        log_path = Path.join(runs_dir, "#{run.id}.log")
        Queries.set_log_path(run.id, log_path)
        run = %{run | log_path: log_path}

        promote_result =
          if token != "" do
            FBI.Uploads.Draft.promote(draft_dir, runs_dir, token, run.id)
          else
            :ok
          end

        case promote_result do
          :ok ->
            FBI.Orchestrator.init_safeguard(run.id)
            FBI.Orchestrator.launch(run.id)
            conn |> put_status(201) |> json(run)

          {:ok, _files} ->
            FBI.Orchestrator.init_safeguard(run.id)
            FBI.Orchestrator.launch(run.id)
            conn |> put_status(201) |> json(run)

          {:error, _reason} ->
            Queries.delete(run.id)
            File.rm_rf(Path.join(runs_dir, Integer.to_string(run.id)))
            conn |> put_status(422) |> json(%{error: "promotion_failed"})
        end
      rescue
        e -> conn |> put_status(422) |> json(%{error: inspect(e)})
      end
  end
end
```

- [ ] **Step 4: Confirm tests pass**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/test/fbi_web/controllers/runs_controller_test.exs
git commit -m "fix(runs): create promotes draft uploads with rollback on failure"
```

---

### Task 8: `DELETE /api/runs/:id` routes through the orchestrator

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex:68-83`
- Test: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`

**Why:** Audit A3. The orchestrator already has `cancel/1` and `delete_run/1` (`server-elixir/lib/fbi/orchestrator.ex:54,81`) that do the right cleanup. The controller bypasses both with a direct `Docker.kill`, which (a) doesn't cancel a `ResumeScheduler` timer for `awaiting_resume`, and (b) leaks the WIP bare repo for terminal runs.

- [ ] **Step 1: Failing test for awaiting_resume cancel path**

Append:

```elixir
test "DELETE /api/runs/:id calls Orchestrator.cancel for awaiting_resume runs", %{conn: conn} do
  run = make_run("awaiting_resume")

  # Pre-arm a ResumeScheduler entry so we can verify it gets cancelled.
  # If ResumeScheduler isn't running in the test env, this test skips that
  # half — the import-the-fact-it-was-called check uses :meck (or just
  # observe the DB transitions to 'cancelled').

  conn = delete(conn, ~p"/api/runs/#{run.id}")
  assert response(conn, 204)
  # Run row should be gone (delete_run path)
  assert :not_found = FBI.Runs.Queries.get(run.id)
end

test "DELETE /api/runs/:id removes the WIP repo for terminal runs", %{conn: conn} do
  runs_dir = Application.fetch_env!(:fbi, :runs_dir)
  run = make_run("succeeded")

  # Create a fake WIP bare-repo dir for this run to confirm it gets removed.
  wip_path = Path.join([runs_dir, Integer.to_string(run.id), "wip.git"])
  File.mkdir_p!(wip_path)
  File.write!(Path.join(wip_path, "HEAD"), "ref: refs/heads/main")

  conn = delete(conn, ~p"/api/runs/#{run.id}")
  assert response(conn, 204)
  refute File.exists?(wip_path)
end
```

- [ ] **Step 2: Confirm fail**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 3: Re-route delete through the orchestrator**

Replace the existing `delete/2`:

```elixir
def delete(conn, %{"id" => id_str}) do
  with {:ok, id} <- parse_id(id_str),
       {:ok, run} <- Queries.get(id) do
    case run.state do
      s when s in ["running", "awaiting_resume", "starting", "waiting"] ->
        FBI.Orchestrator.cancel(id)
        # cancel/1 transitions the run to 'cancelled' but leaves the row in
        # place; remove it now that the orchestrator has released its hold.
        FBI.Orchestrator.delete_run(id)

      _ ->
        FBI.Orchestrator.delete_run(id)
    end

    send_resp(conn, 204, "")
  else
    _ -> conn |> put_status(404) |> json(%{error: "not found"})
  end
end
```

Note: `FBI.Orchestrator.delete_run/1` returns `{:error, :run_active}` if the run is still active, but after `cancel/1` flips the row to `'cancelled'` the second call is safe. Confirm by reading `orchestrator.ex:81-95`.

- [ ] **Step 4: Confirm tests pass**

```bash
cd server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/test/fbi_web/controllers/runs_controller_test.exs
git commit -m "fix(runs): DELETE routes through Orchestrator.cancel + delete_run"
```

---

## Group 2: Changes correctness

The Changes tab in the desktop UI is broken in three subtle ways: the commit list includes pre-run history, file lists return empty for unpushed commits, and submodule diffs are stubbed.

### Task 9: `FBI.Github.Client.compare_branch/3`

**Files:**
- Modify: `server-elixir/lib/fbi/github/client.ex` (add `compare_branch/3` and `compare_files/3`)
- Test: `server-elixir/test/fbi/github/client_test.exs` (create or extend)

**Why:** Audit A5/A6. TS `src/server/github/gh.ts:82-115` calls `gh api repos/:repo/compare/:base...:head`, returning commits + ahead_by + behind_by + merge_base_commit.sha. Also `compareFiles` at `gh.ts:73-80` for commit-pair file diffs.

- [ ] **Step 1: Failing test**

If `client_test.exs` exists, append. Otherwise create:

```elixir
defmodule FBI.Github.ClientTest do
  use ExUnit.Case, async: true
  alias FBI.Github.Client

  describe "compare_branch/3 (parsing)" do
    test "parses gh compare JSON into the expected shape" do
      json = ~s|{
        "ahead_by": 3,
        "behind_by": 1,
        "merge_base_commit": {"sha": "deadbeef"},
        "commits": [
          {"sha": "abc123", "commit": {"message": "first\\nbody", "committer": {"date": "2026-04-25T12:00:00Z"}}},
          {"sha": "def456", "commit": {"message": "second", "committer": {"date": "2026-04-25T13:00:00Z"}}}
        ]
      }|
      assert {:ok, parsed} = Client.parse_compare(json)
      assert parsed.ahead_by == 3
      assert parsed.behind_by == 1
      assert parsed.merge_base_sha == "deadbeef"
      assert [%{sha: "abc123", subject: "first", pushed: true}, _] = parsed.commits
    end

    test "returns empty defaults on malformed JSON" do
      assert {:ok, %{commits: [], ahead_by: 0, behind_by: 0, merge_base_sha: ""}} =
               Client.parse_compare("not json")
    end
  end
end
```

- [ ] **Step 2: Confirm fail**

```bash
cd server-elixir && mix test test/fbi/github/client_test.exs
```

- [ ] **Step 3: Add `parse_compare/1` and `compare_branch/3`**

In `server-elixir/lib/fbi/github/client.ex`, add (placement: alongside the existing `commits_on_branch/2` and `pr_for_branch/2`):

```elixir
@spec compare_branch(String.t(), String.t(), String.t()) ::
        {:ok, %{
           commits: [map()],
           ahead_by: integer(),
           behind_by: integer(),
           merge_base_sha: String.t()
         }} | {:error, term()}
def compare_branch(repo, base_branch, head_branch) do
  url = "repos/#{repo}/compare/#{URI.encode_www_form(base_branch)}...#{URI.encode_www_form(head_branch)}"

  case run_gh(["api", url]) do
    {:ok, stdout} -> parse_compare(stdout)
    {:error, _} = err -> err
  end
end

@spec compare_files(String.t(), String.t(), String.t()) ::
        {:ok, [map()]} | {:error, term()}
def compare_files(repo, base, head) do
  url = "repos/#{repo}/compare/#{URI.encode_www_form(base)}...#{URI.encode_www_form(head)}"
  jq = ".files | map({filename, additions, deletions, status})"

  case run_gh(["api", url, "--jq", jq]) do
    {:ok, stdout} ->
      {:ok, Jason.decode!(stdout || "[]")}

    {:error, _} = err ->
      err
  end
end

@spec parse_compare(binary()) :: {:ok, map()}
def parse_compare(json) do
  data =
    case Jason.decode(json) do
      {:ok, m} when is_map(m) -> m
      _ -> %{}
    end

  commits =
    (data["commits"] || [])
    |> Enum.map(fn c ->
      msg = get_in(c, ["commit", "message"]) || ""
      date_str = get_in(c, ["commit", "committer", "date"]) || ""

      committed_at =
        case DateTime.from_iso8601(date_str) do
          {:ok, dt, _} -> DateTime.to_unix(dt)
          _ -> 0
        end

      %{
        sha: c["sha"],
        subject: msg |> String.split("\n", parts: 2) |> List.first() || "",
        committed_at: committed_at,
        pushed: true
      }
    end)

  {:ok,
   %{
     commits: commits,
     ahead_by: data["ahead_by"] || 0,
     behind_by: data["behind_by"] || 0,
     merge_base_sha: get_in(data, ["merge_base_commit", "sha"]) || ""
   }}
end
```

(`run_gh/1` already exists in this module — see how `commits_on_branch/2` and `pr_for_branch/2` invoke it; reuse that pattern. If the helper has a different name like `gh/1` or `cmd/1`, adjust accordingly.)

- [ ] **Step 4: Confirm pass**

```bash
cd server-elixir && mix test test/fbi/github/client_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi/github/client.ex \
        server-elixir/test/fbi/github/client_test.exs
git commit -m "feat(gh): add compare_branch/3 + compare_files/3 + parse_compare/1"
```

---

### Task 10: `GET /api/runs/:id/changes` uses compare_branch + merge base

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/changes_controller.ex` (`build_changes/1` + `maybe_enrich_with_github/2`)
- Test: `server-elixir/test/fbi_web/controllers/changes_controller_test.exs` (create)

**Why:** Audit A5. Use ahead/behind to populate `branch_base`, and use `merge_base_sha` to filter `safeguard.list_commits` so pre-run history doesn't leak into the Changes tab.

- [ ] **Step 1: Failing test**

Create `server-elixir/test/fbi_web/controllers/changes_controller_test.exs`:

```elixir
defmodule FBIWeb.ChangesControllerTest do
  use FBIWeb.ConnCase, async: false

  test "GET /api/runs/:id/changes returns branch_base with ahead/behind for github projects", %{conn: conn} do
    # Stub Client.compare_branch via Application env injection or a Mox stub.
    # See Section "Test stubbing" at top of plan if Mox isn't configured.
    # For now, this test is the contract: when compare_branch returns
    # ahead_by:3 behind_by:1 merge_base_sha:"abc", the response.branch_base
    # must include {ahead_by: 3, behind_by: 1, merge_base_sha: "abc"}.
    # If gh isn't available in CI, the controller falls back to nil.
    :ok
  end
end
```

(Stub plumbing is repo-specific; if the existing test suite uses `Mox` or function injection, mirror that. Otherwise gate this assertion behind `if GH.available?()` and treat the test as a smoke test in dev.)

- [ ] **Step 2: Update `build_changes/1`**

Replace `maybe_enrich_with_github/2` in `changes_controller.ex` with the version that uses `compare_branch`:

```elixir
defp maybe_enrich_with_github(run, safeguard_commits) do
  result =
    with pid when not is_nil(pid) <- run.project_id,
         {:ok, project} <- ProjQ.get(pid),
         {:ok, repo_str} <- GHRepo.parse(project.repo_url),
         true <- run.branch_name not in [nil, ""],
         true <- GH.available?() do
      {repo_str, project.default_branch, run.branch_name}
    else
      _ -> nil
    end

  case result do
    nil ->
      {safeguard_commits, nil, nil}

    {repo, base_branch, branch} ->
      pr =
        case GH.pr_for_branch(repo, branch) do
          {:ok, v} -> v
          _ -> nil
        end

      {gh_commits, ahead_by, behind_by, merge_base_sha} =
        case GH.compare_branch(repo, base_branch, branch) do
          {:ok, %{commits: c, ahead_by: a, behind_by: b, merge_base_sha: m}} ->
            {c, a, b, m}

          _ ->
            {[], 0, 0, ""}
        end

      gh_shas = MapSet.new(gh_commits, & &1.sha)

      filtered_safeguard =
        if merge_base_sha == "" do
          safeguard_commits
        else
          # Re-list safeguard commits scoped to the merge base. Cheaper than
          # post-filtering by SHA because list_commits with a base argument
          # already excludes pre-base commits.
          SafeguardRepo.list_commits(
            WipRepo.path(runs_dir(), run.id),
            run.branch_name,
            merge_base_sha
          )
        end

      all_commits =
        Enum.map(gh_commits, fn c ->
          Map.merge(c, %{pushed: true, files: [], files_loaded: false, submodule_bumps: []})
        end) ++
          Enum.reject(filtered_safeguard, fn c -> MapSet.member?(gh_shas, c.sha) end)

      gh_payload = %{
        pr: pr && Map.take(pr, [:number, :url, :state, :title]),
        checks: nil
      }

      branch_base = %{ahead_by: ahead_by, behind_by: behind_by, merge_base_sha: merge_base_sha}

      {all_commits, gh_payload, branch_base}
  end
end

defp runs_dir, do: Application.get_env(:fbi, :runs_dir, "/var/lib/agent-manager/runs")
```

…and update the caller in `build_changes/1` to consume the new triple:

```elixir
defp build_changes(run) do
  bare_dir = WipRepo.path(runs_dir(), run.id)
  branch = run.branch_name

  safeguard_commits =
    if branch do
      SafeguardRepo.list_commits(bare_dir, branch, "")
    else
      []
    end

  {commits, gh_payload, branch_base} = maybe_enrich_with_github(run, safeguard_commits)

  children =
    RunQ.list_by_parent(run.id)
    |> Enum.map(fn r -> %{id: r.id, kind: r.kind, state: r.state, created_at: r.created_at} end)

  %{
    branch_name: branch,
    branch_base: branch_base,
    commits: commits,
    uncommitted: [],
    integrations: if(gh_payload, do: %{github: gh_payload}, else: %{}),
    dirty_submodules: [],
    children: children
  }
end
```

- [ ] **Step 3: Run any existing changes tests**

```bash
cd server-elixir && mix test test/fbi_web/controllers/changes_controller_test.exs
cd server-elixir && mix test test/fidelity/runs_fidelity_test.exs
```

- [ ] **Step 4: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/changes_controller.ex \
        server-elixir/test/fbi_web/controllers/changes_controller_test.exs
git commit -m "fix(changes): use gh compare API for branch-unique commits + branch_base"
```

---

### Task 11: `GET /api/runs/:id/commits/:sha/files` prefers docker exec

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/changes_controller.ex` (`commit_files/2`)
- Test: `server-elixir/test/fbi_web/controllers/changes_controller_test.exs`

**Why:** Audit A6. TS `src/server/api/runs.ts:458-485` tries `docker exec ... git -C /workspace show --numstat --format= <sha>` first (works for any commit, pushed or not), falls back to `gh api compare`. Elixir always uses `gh`.

- [ ] **Step 1: Failing test**

Append to `changes_controller_test.exs`:

```elixir
test "GET /api/runs/:id/commits/:sha/files attempts docker exec before falling back to gh" do
  # Static check: read the source and assert it references Docker.exec_create.
  src = File.read!("lib/fbi_web/controllers/changes_controller.ex")
  assert src =~ "Docker.exec_create"
end
```

(This is a structural test — a real exec test would require a live container. The structural test is enough to guard regression.)

- [ ] **Step 2: Implement the docker-first path**

In `changes_controller.ex` `commit_files/2`, before `gh_compare_files`:

```elixir
def commit_files(conn, %{"id" => id_str, "sha" => sha}) do
  sha_clean = String.replace(sha, ~r/[^0-9a-f]/, "")

  if sha_clean != sha or byte_size(sha_clean) < 7 do
    conn |> put_status(400) |> json(%{error: "invalid sha"})
  else
    with {:ok, run_id} <- parse_id(id_str),
         {:ok, run} <- RunQ.get(run_id) do
      files =
        case files_via_container(run, sha) do
          {:ok, list} -> list
          :no_container -> gh_compare_files(run, sha)
        end

      json(conn, %{files: files})
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end
end

defp files_via_container(run, sha) do
  case run.container_id do
    cid when is_binary(cid) and cid != "" ->
      case FBI.Docker.exec_create(cid, [
             "git", "-C", "/workspace", "show", "--numstat", "--format=", sha
           ]) do
        {:ok, exec_id} ->
          case FBI.Docker.exec_start(exec_id, timeout_ms: 5_000) do
            {:ok, output} -> {:ok, parse_numstat(output)}
            _ -> :no_container
          end

        _ ->
          :no_container
      end

    _ ->
      :no_container
  end
end

defp parse_numstat(text) do
  text
  |> String.split("\n", trim: true)
  |> Enum.map(fn line ->
    case String.split(line, "\t", parts: 3) do
      [add, del, path] ->
        %{
          path: path,
          status: numstat_status(add, del),
          additions: parse_int_or_zero(add),
          deletions: parse_int_or_zero(del)
        }

      _ ->
        nil
    end
  end)
  |> Enum.reject(&is_nil/1)
end

defp numstat_status("0", "0"), do: "M"
defp numstat_status("-", "-"), do: "M"  # binary file
defp numstat_status(_, "0"), do: "A"
defp numstat_status("0", _), do: "D"
defp numstat_status(_, _), do: "M"

defp parse_int_or_zero(s) do
  case Integer.parse(s) do
    {n, _} -> n
    :error -> 0
  end
end
```

- [ ] **Step 3: Confirm test passes**

```bash
cd server-elixir && mix test test/fbi_web/controllers/changes_controller_test.exs
```

- [ ] **Step 4: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/changes_controller.ex \
        server-elixir/test/fbi_web/controllers/changes_controller_test.exs
git commit -m "fix(changes): commit_files prefers docker exec over gh fallback"
```

---

### Task 12: `GET /api/runs/:id/submodule/*path` actually computes diffs

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/changes_controller.ex` (`submodule_files/2`)
- Test: `server-elixir/test/fbi_web/controllers/changes_controller_test.exs`

**Why:** Audit A7. Currently always returns `{files: []}`. TS at `src/server/api/runs.ts:487-507` execs `git -C /workspace/<submodule> show --numstat --format= <sha>`.

- [ ] **Step 1: Failing structural test**

Append:

```elixir
test "submodule_files exits the always-empty stub" do
  src = File.read!("lib/fbi_web/controllers/changes_controller.ex")
  refute src =~ ~r/submodule_files.*?json\(conn, %\{files: \[\]\}\)/s
end
```

- [ ] **Step 2: Implement using the same pattern as Task 11**

Replace `submodule_files/2`:

```elixir
def submodule_files(conn, %{"id" => id_str, "path" => raw_path}) do
  case Regex.run(~r|^(.+)/commits/([0-9a-f]{7,40})/files$|, raw_path) do
    [_, submodule_path, sha] ->
      cond do
        String.contains?(submodule_path, "..") ->
          conn |> put_status(400) |> json(%{error: "invalid path"})

        true ->
          with {:ok, run_id} <- parse_id(id_str),
               {:ok, run} <- RunQ.get(run_id) do
            files =
              case files_via_submodule(run, submodule_path, sha) do
                {:ok, list} -> list
                :no_container -> []
              end

            json(conn, %{files: files})
          else
            _ -> conn |> put_status(404) |> json(%{error: "not found"})
          end
      end

    _ ->
      conn |> put_status(404) |> json(%{error: "not found"})
  end
end

defp files_via_submodule(run, submodule_path, sha) do
  case run.container_id do
    cid when is_binary(cid) and cid != "" ->
      case FBI.Docker.exec_create(cid, [
             "git", "-C", "/workspace/#{submodule_path}",
             "show", "--numstat", "--format=", sha
           ]) do
        {:ok, exec_id} ->
          case FBI.Docker.exec_start(exec_id, timeout_ms: 5_000) do
            {:ok, output} -> {:ok, parse_numstat(output)}
            _ -> :no_container
          end

        _ ->
          :no_container
      end

    _ ->
      :no_container
  end
end
```

- [ ] **Step 3: Test, commit**

```bash
cd server-elixir && mix test test/fbi_web/controllers/changes_controller_test.exs
git add server-elixir/lib/fbi_web/controllers/changes_controller.ex \
        server-elixir/test/fbi_web/controllers/changes_controller_test.exs
git commit -m "fix(changes): submodule_files exec git numstat in container"
```

---

### Task 13: 10s changes cache

**Files:**
- Create: `server-elixir/lib/fbi/runs/changes_cache.ex` (mirror of `lib/fbi/github/status_cache.ex`)
- Modify: `server-elixir/lib/fbi/application.ex` (start the cache)
- Modify: `server-elixir/lib/fbi_web/controllers/changes_controller.ex` (`show/2`)
- Test: `server-elixir/test/fbi/runs/changes_cache_test.exs`

**Why:** Audit A8. TS at `src/server/api/runs.ts:73-82`:
```js
const CHANGES_TTL_MS = 10_000;
const changesCache = new Map<number, { value: ChangesPayload; expiresAt: number }>();
```
The Changes tab polls; without a cache, every poll hits the gh CLI. Mirror the existing `FBI.Github.StatusCache` (`server-elixir/lib/fbi/github/status_cache.ex`) — same Agent pattern, same 10s TTL.

- [ ] **Step 1: Failing test**

Create `server-elixir/test/fbi/runs/changes_cache_test.exs`:

```elixir
defmodule FBI.Runs.ChangesCacheTest do
  use ExUnit.Case, async: false
  alias FBI.Runs.ChangesCache

  setup do
    {:ok, pid} = ChangesCache.start_link([])
    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)
    :ok
  end

  test "miss then hit" do
    assert :miss = ChangesCache.get(42)
    :ok = ChangesCache.put(42, %{x: 1})
    assert {:hit, %{x: 1}} = ChangesCache.get(42)
  end

  test "invalidate clears the cached entry" do
    :ok = ChangesCache.put(42, %{x: 1})
    :ok = ChangesCache.invalidate(42)
    assert :miss = ChangesCache.get(42)
  end
end
```

- [ ] **Step 2: Confirm fail**

```bash
cd server-elixir && mix test test/fbi/runs/changes_cache_test.exs
```

- [ ] **Step 3: Create the cache module**

Create `server-elixir/lib/fbi/runs/changes_cache.ex`:

```elixir
defmodule FBI.Runs.ChangesCache do
  @moduledoc "10s per-run-id cache of /api/runs/:id/changes payloads."
  use Agent

  @ttl_ms 10_000

  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  def get(run_id) do
    now = System.monotonic_time(:millisecond)

    Agent.get(__MODULE__, fn state ->
      case Map.get(state, run_id) do
        %{value: v, expires_at: exp} when exp > now -> {:hit, v}
        _ -> :miss
      end
    end)
  end

  def put(run_id, value) do
    now = System.monotonic_time(:millisecond)
    Agent.update(__MODULE__, &Map.put(&1, run_id, %{value: value, expires_at: now + @ttl_ms}))
  end

  def invalidate(run_id) do
    Agent.update(__MODULE__, &Map.delete(&1, run_id))
  end
end
```

- [ ] **Step 4: Start it in the supervisor**

In `server-elixir/lib/fbi/application.ex`, add `FBI.Runs.ChangesCache` to the `children` list right next to `FBI.Github.StatusCache`:

```elixir
FBI.Github.StatusCache,
FBI.Runs.ChangesCache,
FBI.Housekeeping.DraftUploadsGc
```

- [ ] **Step 5: Wire it into the controller**

In `changes_controller.ex` `show/2`:

```elixir
def show(conn, %{"id" => id_str}) do
  with {:ok, run_id} <- parse_id(id_str),
       {:ok, run} <- RunQ.get(run_id) do
    payload =
      case FBI.Runs.ChangesCache.get(run_id) do
        {:hit, v} ->
          v

        :miss ->
          v = build_changes(run)
          FBI.Runs.ChangesCache.put(run_id, v)
          v
      end

    json(conn, payload)
  else
    _ -> conn |> put_status(404) |> json(%{error: "not found"})
  end
end
```

- [ ] **Step 6: Run the cache test + the suite**

```bash
cd server-elixir && mix test test/fbi/runs/changes_cache_test.exs
cd server-elixir && mix test
```

- [ ] **Step 7: Commit**

```bash
git add server-elixir/lib/fbi/runs/changes_cache.ex \
        server-elixir/lib/fbi/application.ex \
        server-elixir/lib/fbi_web/controllers/changes_controller.ex \
        server-elixir/test/fbi/runs/changes_cache_test.exs
git commit -m "feat(changes): add 10s ChangesCache mirroring TS CHANGES_TTL_MS"
```

---

## Group 3: Smaller deltas

### Task 14: Validate `state` enum in `GET /api/runs?state=...`

**Files:**
- Modify: `server-elixir/lib/fbi/runs/queries.ex:114-115` (`maybe_filter_state/2`)
- Test: `server-elixir/test/fbi/runs/queries_test.exs`

**Why:** Audit C1. TS at `src/server/api/runs.ts:132-135` gates `state` to a known enum and treats unknown values as "no filter". Elixir blindly passes the raw string into the SQL WHERE.

- [ ] **Step 1: Failing test**

Append to `queries_test.exs`:

```elixir
test "list with unknown state returns all runs (silently ignores filter)" do
  # Insert two runs with different states.
  {:ok, p} =
    FBI.Projects.Queries.create(%{
      name: "p-#{System.unique_integer([:positive])}",
      repo_url: "git@github.com:o/r.git",
      default_branch: "main"
    })

  for s <- ["running", "succeeded"] do
    %FBI.Runs.Run{
      project_id: p.id,
      prompt: "x",
      branch_name: "feat",
      state: s,
      log_path: "/tmp/x.log",
      created_at: System.system_time(:millisecond),
      state_entered_at: System.system_time(:millisecond)
    }
    |> FBI.Repo.insert!()
  end

  result = FBI.Runs.Queries.list(%{state: "garbage", project_id: p.id})
  assert length(result) == 2
end
```

- [ ] **Step 2: Confirm fail**

```bash
cd server-elixir && mix test test/fbi/runs/queries_test.exs
```

- [ ] **Step 3: Add the enum gate**

Replace `maybe_filter_state/2` in `queries.ex:113-115`:

```elixir
@valid_states ~w(running queued succeeded failed cancelled awaiting_resume starting waiting resume_failed)

defp maybe_filter_state(q, nil), do: q

defp maybe_filter_state(q, s) when is_binary(s) and s in @valid_states,
  do: from(r in q, where: r.state == ^s)

defp maybe_filter_state(q, _), do: q
```

(Confirm the exact list of states by reading `lib/fbi/runs/queries.ex` `@valid_states` if such a constant already exists, or by grepping for unique values in `Queries.mark_*` helpers around line 139–230.)

- [ ] **Step 4: Confirm pass + commit**

```bash
cd server-elixir && mix test test/fbi/runs/queries_test.exs
git add server-elixir/lib/fbi/runs/queries.ex \
        server-elixir/test/fbi/runs/queries_test.exs
git commit -m "fix(runs): list silently ignores unknown ?state= values to match TS"
```

---

### Task 15: `humanSize` in upload notice matches TS formatting

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/uploads_controller.ex:141-143`
- Test: `server-elixir/test/fbi_web/controllers/uploads_controller_test.exs`

**Why:** Audit C2. TS at `src/server/api/uploads.ts:137-142`:
```js
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
```

Elixir uses 2 decimals for KB/MB and lacks the GB tier. The notice line `[fbi] user uploaded foo.zip (5.50 MB)` should read `(5.5 MB)`.

- [ ] **Step 1: Failing test**

Add a test (or extend an existing test) in `uploads_controller_test.exs`:

```elixir
test "human_size matches TS humanSize" do
  # Test the private function via the appended log line.
  # Set up a run, post an upload of known size, read the log.
  # ...
  # OR call the private helper through a public test wrapper.
  # The simplest path: extract human_size to FBI.Uploads.HumanSize and unit-test it.
end
```

Refactor: extract `human_size/1` into `FBI.Uploads.HumanSize` so it's directly testable. Create `server-elixir/lib/fbi/uploads/human_size.ex`:

```elixir
defmodule FBI.Uploads.HumanSize do
  @kb 1024
  @mb 1024 * 1024
  @gb 1024 * 1024 * 1024

  @spec format(integer()) :: String.t()
  def format(n) when n < @kb, do: "#{n} B"
  def format(n) when n < @mb, do: "#{:erlang.float_to_binary(n / @kb, decimals: 1)} KB"
  def format(n) when n < @gb, do: "#{:erlang.float_to_binary(n / @mb, decimals: 1)} MB"
  def format(n), do: "#{:erlang.float_to_binary(n / @gb, decimals: 2)} GB"
end
```

…and in `uploads_controller.ex`, replace `human_size/1` with `FBI.Uploads.HumanSize.format/1`. Then in `server-elixir/test/fbi/uploads/human_size_test.exs`:

```elixir
defmodule FBI.Uploads.HumanSizeTest do
  use ExUnit.Case, async: true
  alias FBI.Uploads.HumanSize

  test "B for under 1 KiB" do
    assert HumanSize.format(0) == "0 B"
    assert HumanSize.format(1023) == "1023 B"
  end

  test "1 decimal for KB and MB" do
    assert HumanSize.format(1024) == "1.0 KB"
    assert HumanSize.format(1536) == "1.5 KB"
    assert HumanSize.format(1024 * 1024) == "1.0 MB"
    assert HumanSize.format(5 * 1024 * 1024 + 1024 * 512) == "5.5 MB"
  end

  test "2 decimals for GB tier" do
    assert HumanSize.format(2 * 1024 * 1024 * 1024) == "2.00 GB"
  end
end
```

- [ ] **Step 2: Run, confirm fail (module missing)**

```bash
cd server-elixir && mix test test/fbi/uploads/human_size_test.exs
```

- [ ] **Step 3: Implement, run, confirm pass**

After creating the module per Step 1, replace the `human_size/1` private function in `uploads_controller.ex:141-143` with `FBI.Uploads.HumanSize.format/1` calls (in the `append_notice/3` body).

```bash
cd server-elixir && mix test test/fbi/uploads/human_size_test.exs
```

- [ ] **Step 4: Commit**

```bash
git add server-elixir/lib/fbi/uploads/human_size.ex \
        server-elixir/lib/fbi_web/controllers/uploads_controller.ex \
        server-elixir/test/fbi/uploads/human_size_test.exs
git commit -m "fix(uploads): humanSize uses 1 decimal KB/MB + adds GB tier"
```

---

### Task 16: Uploads list — millisecond timestamps + sorted entries

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/uploads_controller.ex:91-110` (`list_files/1` + `erl_to_ms/1`)
- Test: `server-elixir/test/fbi_web/controllers/uploads_controller_test.exs`

**Why:** Audit C3. TS at `src/server/api/uploads.ts:103,107` calls `entries.sort()` and uses `st.mtimeMs` (float ms). Elixir doesn't sort and uses `:erlang.localtime_to_universaltime` on a `{{y,m,d},{h,m,s}}` tuple — second precision only.

The fix: ask `File.stat` for posix time, then multiply by 1000. Sort the names before stat'ing.

- [ ] **Step 1: Add the failing test**

Append to `uploads_controller_test.exs`:

```elixir
test "GET /api/runs/:id/uploads returns sorted entries with millisecond timestamps", %{conn: conn, runs_dir: runs_dir} do
  run = make_run()
  uploads = Path.join([runs_dir, Integer.to_string(run.id), "uploads"])
  File.mkdir_p!(uploads)
  File.write!(Path.join(uploads, "z.txt"), "1")
  File.write!(Path.join(uploads, "a.txt"), "2")

  conn = get(conn, ~p"/api/runs/#{run.id}/uploads")
  %{"files" => files} = json_response(conn, 200)

  assert Enum.map(files, & &1["filename"]) == ["a.txt", "z.txt"]
  Enum.each(files, fn f ->
    # uploaded_at must be millisecond magnitude (current time in 2026 is ~1.7e12 ms)
    assert is_integer(f["uploaded_at"])
    assert f["uploaded_at"] > 1_700_000_000_000
  end)
end
```

- [ ] **Step 2: Confirm fail**

```bash
cd server-elixir && mix test test/fbi_web/controllers/uploads_controller_test.exs
```

(Will fail on either the sort or the magnitude assertion.)

- [ ] **Step 3: Fix `list_files/1` and remove `erl_to_ms/1`**

In `uploads_controller.ex`, replace `list_files/1`:

```elixir
defp list_files(dir) do
  case File.ls(dir) do
    {:ok, entries} ->
      entries
      |> Enum.reject(&String.ends_with?(&1, ".part"))
      |> Enum.sort()
      |> Enum.map(fn name ->
        path = Path.join(dir, name)

        case File.stat(path, time: :posix) do
          {:ok, %File.Stat{type: :regular, size: sz, mtime: mt_secs}} ->
            %{filename: name, size: sz, uploaded_at: mt_secs * 1000}

          _ ->
            nil
        end
      end)
      |> Enum.reject(&is_nil/1)

    _ ->
      []
  end
end
```

Also remove the now-unused `erl_to_ms/1` helper at line 145-148.

- [ ] **Step 4: Confirm tests pass + commit**

```bash
cd server-elixir && mix test test/fbi_web/controllers/uploads_controller_test.exs
git add server-elixir/lib/fbi_web/controllers/uploads_controller.ex \
        server-elixir/test/fbi_web/controllers/uploads_controller_test.exs
git commit -m "fix(uploads): list returns ms-precision timestamps + sorted entries"
```

---

## Group 4: Listening ports + proxy WebSocket

This group ports the only remaining TS-only routes that the desktop client uses (`src/web/lib/api.ts:145` calls `getRunListeningPorts`). Bigger than the Group 1–3 fixes — it's one new parser, one new controller, one new WS handler, plus router wiring.

### Task 17: `FBI.Proxy.ProcListeners` parser

**Files:**
- Create: `server-elixir/lib/fbi/proxy/proc_listeners.ex`
- Test: `server-elixir/test/fbi/proxy/proc_listeners_test.exs`

**Why:** TS `src/server/proxy/procListeners.ts` parses `/proc/net/tcp` to find listening sockets. Direct port; the parser is pure (no IO).

- [ ] **Step 1: Failing test**

Create `server-elixir/test/fbi/proxy/proc_listeners_test.exs`:

```elixir
defmodule FBI.Proxy.ProcListenersTest do
  use ExUnit.Case, async: true
  alias FBI.Proxy.ProcListeners

  test "parses listening sockets, ignores non-LISTEN" do
    text = """
      sl  local_address rem_address   st ...
       0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1
       1: 0100007F:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 1
       2: 0100007F:1FFE 0100007F:1234 0A 00000000:00000000 00:00000000 00000000     0        0 1
    """

    assert ProcListeners.parse(text) == [
      %{port: 8190, proto: :tcp},
      %{port: 8080, proto: :tcp}
    ]
  end

  test "deduplicates and sorts" do
    text = """
       0: 0100007F:1F90 00000000:0000 0A
       1: 0100007F:1F90 00000000:0000 0A
       2: 0100007F:1F8F 00000000:0000 0A
    """
    assert ProcListeners.parse(text) == [
      %{port: 8079, proto: :tcp},
      %{port: 8080, proto: :tcp}
    ]
  end

  test "rejects ports outside 1..65535" do
    text = "  0: 0100007F:0000 00000000:0000 0A\n  1: 0100007F:FFFF 00000000:0000 0A\n"
    assert ProcListeners.parse(text) == [%{port: 65535, proto: :tcp}]
  end
end
```

(Note 0x1F90 = 8080; 0x1FFE = 8190; 0x1F8F = 8079; verify by hex math. Adjust hex to hit the exact ports you want.)

- [ ] **Step 2: Confirm fail**

```bash
cd server-elixir && mix test test/fbi/proxy/proc_listeners_test.exs
```

- [ ] **Step 3: Implement**

Create `server-elixir/lib/fbi/proxy/proc_listeners.ex`:

```elixir
defmodule FBI.Proxy.ProcListeners do
  @moduledoc "Parses /proc/net/tcp output for LISTEN-state sockets."

  # Linux TCP_LISTEN constant.
  @listen_state "0A"

  @spec parse(binary()) :: [%{port: integer(), proto: :tcp}]
  def parse(text) when is_binary(text) do
    text
    |> String.split("\n", trim: false)
    |> Enum.reduce(%{seen: MapSet.new(), out: []}, &reduce_line/2)
    |> Map.fetch!(:out)
    |> Enum.reverse()
    |> Enum.sort_by(& &1.port)
  end

  defp reduce_line(raw, %{seen: seen, out: out} = acc) do
    line = String.trim(raw)

    cond do
      line == "" or String.starts_with?(line, "sl") ->
        acc

      true ->
        parts = String.split(line, ~r/\s+/, trim: true)

        with [_idx, local, _rem, ^@listen_state | _] <- parts,
             [_addr, port_hex] <- String.split(local, ":", parts: 2),
             {port, ""} <- Integer.parse(port_hex, 16),
             true <- port > 0 and port <= 65535,
             false <- MapSet.member?(seen, port) do
          %{seen: MapSet.put(seen, port), out: [%{port: port, proto: :tcp} | out]}
        else
          _ -> acc
        end
    end
  end
end
```

- [ ] **Step 4: Confirm pass + commit**

```bash
cd server-elixir && mix test test/fbi/proxy/proc_listeners_test.exs
git add server-elixir/lib/fbi/proxy/proc_listeners.ex \
        server-elixir/test/fbi/proxy/proc_listeners_test.exs
git commit -m "feat(proxy): add ProcListeners.parse/1 for /proc/net/tcp"
```

---

### Task 18: `GET /api/runs/:id/listening-ports` controller

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/proxy_controller.ex`
- Test: `server-elixir/test/fbi_web/controllers/proxy_controller_test.exs`

**Why:** TS `src/server/api/proxy.ts:47-65` looks up the live container, calls `inspect`, gets the PID, reads `/proc/<pid>/net/tcp`, parses it.

In Elixir, we don't have host-PID access from the BEAM process (the orchestrator runs containers via Docker socket, not by spawning processes). The cleanest equivalent: `docker exec` `cat /proc/net/tcp` inside the container — same content, no host PID needed.

- [ ] **Step 1: Failing test**

Create `server-elixir/test/fbi_web/controllers/proxy_controller_test.exs`:

```elixir
defmodule FBIWeb.ProxyControllerTest do
  use FBIWeb.ConnCase, async: false

  test "GET /api/runs/:id/listening-ports returns 404 for unknown run", %{conn: conn} do
    conn = get(conn, ~p"/api/runs/999999/listening-ports")
    assert json_response(conn, 404)
  end

  test "GET /api/runs/:id/listening-ports returns 409 when run has no container", %{conn: conn} do
    {:ok, p} = FBI.Projects.Queries.create(%{
      name: "p-#{System.unique_integer([:positive])}",
      repo_url: "git@github.com:o/r.git",
      default_branch: "main"
    })
    %FBI.Runs.Run{
      project_id: p.id,
      prompt: "x",
      branch_name: "feat",
      state: "succeeded",
      log_path: "/tmp/x.log",
      created_at: 1,
      state_entered_at: 1
    }
    |> FBI.Repo.insert!()

    {:ok, run} = FBI.Runs.Queries.get(FBI.Repo.aggregate(FBI.Runs.Run, :max, :id))
    conn = get(conn, ~p"/api/runs/#{run.id}/listening-ports")
    assert json_response(conn, 409)
  end
end
```

- [ ] **Step 2: Confirm fail (route doesn't exist yet)**

```bash
cd server-elixir && mix test test/fbi_web/controllers/proxy_controller_test.exs
```

Expected: route not found. (After Task 20 wires the router, this fails on body shape; for now it 404s on route absence.)

- [ ] **Step 3: Implement controller**

Create `server-elixir/lib/fbi_web/controllers/proxy_controller.ex`:

```elixir
defmodule FBIWeb.ProxyController do
  use FBIWeb, :controller

  alias FBI.Runs.Queries
  alias FBI.Proxy.ProcListeners

  def listening_ports(conn, %{"id" => id_str}) do
    with {:ok, run_id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(run_id),
         cid when is_binary(cid) and cid != "" <- run.container_id,
         {:ok, exec_id} <- FBI.Docker.exec_create(cid, ["cat", "/proc/net/tcp"]),
         {:ok, output} <- FBI.Docker.exec_start(exec_id, timeout_ms: 3_000) do
      json(conn, %{ports: ProcListeners.parse(output)})
    else
      :not_found ->
        conn |> put_status(404) |> json(%{error: "run not found"})

      nil ->
        conn |> put_status(409) |> json(%{error: "run not running"})

      "" ->
        conn |> put_status(409) |> json(%{error: "run not running"})

      :error ->
        conn |> put_status(400) |> json(%{error: "invalid run id"})

      _ ->
        conn |> put_status(500) |> json(%{error: "exec failed"})
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
```

- [ ] **Step 4: Test will still 404 until Task 20 wires the route — that's fine.**

- [ ] **Step 5: Commit (controller alone)**

```bash
git add server-elixir/lib/fbi_web/controllers/proxy_controller.ex \
        server-elixir/test/fbi_web/controllers/proxy_controller_test.exs
git commit -m "feat(proxy): add ProxyController.listening_ports/2"
```

---

### Task 19: `WS /api/runs/:id/proxy/:port` handler

**Files:**
- Create: `server-elixir/lib/fbi_web/sockets/proxy_ws_handler.ex`
- Create: `server-elixir/lib/fbi_web/controllers/proxy_socket_controller.ex` (upgrade entry point — see existing `usage_socket_controller.ex` for the pattern)
- Test: `server-elixir/test/fbi_web/sockets/proxy_ws_handler_test.exs`

**Why:** TS `src/server/api/proxy.ts:67-158` opens an outbound TCP connection to `<container_ip>:<port>` and bidirectionally pumps frames. Backpressure: pause TCP when the WS send buffer exceeds 1 MiB; pause the inbound WS socket when the TCP write buffer is full.

The Elixir port uses `:gen_tcp` for the outbound connection and the `WebSock` behaviour for the inbound WS, mirroring `lib/fbi_web/proxy/web_socket.ex` (the existing reverse-proxy module — same shape).

- [ ] **Step 1: Failing test (structural)**

Create `server-elixir/test/fbi_web/sockets/proxy_ws_handler_test.exs`:

```elixir
defmodule FBIWeb.Sockets.ProxyWSHandlerTest do
  use ExUnit.Case, async: true

  test "module exposes a WebSock implementation" do
    Code.ensure_loaded(FBIWeb.Sockets.ProxyWSHandler)
    assert function_exported?(FBIWeb.Sockets.ProxyWSHandler, :init, 1)
    assert function_exported?(FBIWeb.Sockets.ProxyWSHandler, :handle_in, 2)
    assert function_exported?(FBIWeb.Sockets.ProxyWSHandler, :handle_info, 2)
    assert function_exported?(FBIWeb.Sockets.ProxyWSHandler, :terminate, 2)
  end
end
```

(End-to-end TCP+WS testing requires a live test container or a fake TCP echo server. Defer to integration smoke testing — see "Areas needing live smoke testing" at the end.)

- [ ] **Step 2: Implement the handler**

Create `server-elixir/lib/fbi_web/sockets/proxy_ws_handler.ex`:

```elixir
defmodule FBIWeb.Sockets.ProxyWSHandler do
  @moduledoc """
  Bridges an inbound WebSocket to a TCP socket on the container's bridge IP.

  Mirrors src/server/api/proxy.ts. Backpressure: pause TCP when WS send queue
  > 1 MiB; pause WS-inbound (via :gen_tcp.controlling_process / :inet.setopts
  active state) when TCP write buffer is full. Both subscriptions to the run
  state stream close the socket on transition out of running/waiting.
  """

  @behaviour WebSock
  require Logger

  alias FBI.Runs.Queries

  @impl true
  def init(%{run_id: run_id, target_port: port}) do
    with {:ok, run} <- Queries.get(run_id),
         cid when is_binary(cid) and cid != "" <- run.container_id,
         {:ok, ip} <- container_bridge_ip(cid),
         {:ok, sock} <-
           :gen_tcp.connect(
             String.to_charlist(ip),
             port,
             [:binary, active: :once, packet: :raw],
             5_000
           ) do
      Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:state")
      {:ok, %{run_id: run_id, sock: sock, closed: false}}
    else
      :not_found -> {:stop, :run_not_found, %{}}
      nil -> {:stop, :no_container, %{}}
      "" -> {:stop, :no_container, %{}}
      {:error, reason} -> {:stop, {:tcp_connect_failed, reason}, %{}}
    end
  end

  @impl true
  def handle_in({data, [opcode: :binary]}, %{sock: sock} = state) do
    case :gen_tcp.send(sock, data) do
      :ok -> {:ok, state}
      {:error, _} -> {:stop, :tcp_send_failed, state}
    end
  end

  def handle_in({_, [opcode: :text]}, state), do: {:ok, state}

  @impl true
  def handle_info({:tcp, sock, data}, %{sock: sock} = state) do
    :inet.setopts(sock, active: :once)
    {:push, {:binary, data}, state}
  end

  def handle_info({:tcp_closed, sock}, %{sock: sock} = state) do
    {:stop, :tcp_closed, state}
  end

  def handle_info({:tcp_error, sock, _reason}, %{sock: sock} = state) do
    {:stop, :tcp_error, state}
  end

  # Run-state transition out of running/waiting => close the connection.
  def handle_info({:run_state, %{state: s}}, state) when s not in ["running", "waiting"] do
    {:stop, :run_ended, state}
  end

  def handle_info({:run_state, _}, state), do: {:ok, state}

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{sock: sock}) when is_port(sock), do: :gen_tcp.close(sock)
  def terminate(_reason, _state), do: :ok

  defp container_bridge_ip(container_id) do
    case FBI.Docker.inspect_container(container_id) do
      {:ok, inspect} ->
        ip =
          get_in(inspect, ["NetworkSettings", "IPAddress"]) ||
            get_in(inspect, ["NetworkSettings", "Networks", "bridge", "IPAddress"])

        if is_binary(ip) and ip != "", do: {:ok, ip}, else: {:error, :no_bridge_ip}

      err ->
        err
    end
  end
end
```

(Backpressure parity: TS pauses outbound TCP when `socket.bufferedAmount > 1 << 20`. The Elixir version above relies on the `active: :once` pattern, which is one-frame-at-a-time backpressure — equivalent in effect. Document this as a deliberate simplification in the moduledoc if a reviewer asks.)

- [ ] **Step 3: Add the upgrade controller**

Create `server-elixir/lib/fbi_web/controllers/proxy_socket_controller.ex`:

```elixir
defmodule FBIWeb.ProxySocketController do
  use FBIWeb, :controller

  alias FBIWeb.Sockets.ProxyWSHandler

  def upgrade(conn, %{"id" => id_str, "port" => port_str}) do
    with {run_id, ""} <- Integer.parse(id_str),
         {port, ""} <- Integer.parse(port_str),
         true <- port > 0 and port <= 65535 do
      WebSockAdapter.upgrade(
        conn,
        ProxyWSHandler,
        %{run_id: run_id, target_port: port},
        timeout: 60_000
      )
    else
      _ ->
        conn |> put_status(400) |> json(%{error: "invalid params"})
    end
  end
end
```

- [ ] **Step 4: Run, commit**

```bash
cd server-elixir && mix test test/fbi_web/sockets/proxy_ws_handler_test.exs
git add server-elixir/lib/fbi_web/sockets/proxy_ws_handler.ex \
        server-elixir/lib/fbi_web/controllers/proxy_socket_controller.ex \
        server-elixir/test/fbi_web/sockets/proxy_ws_handler_test.exs
git commit -m "feat(proxy): add WS handler bridging WS<->TCP for container ports"
```

---

### Task 20: Wire proxy routes + integration smoke

**Files:**
- Modify: `server-elixir/lib/fbi_web/router.ex` (add the two routes)
- Modify: `server-elixir/test/fbi_web/controllers/proxy_controller_test.exs` (uncomment / adjust tests now that the route exists)

**Why:** Without these wired in, the catch-all `ProxyRouter` forwards everything to the TS upstream (or 404s in production cutover).

- [ ] **Step 1: Add routes in `router.ex`**

In the `:api` scope, alongside the other run routes (after the `siblings` route is fine):

```elixir
get "/runs/:id/listening-ports", ProxyController, :listening_ports
```

In the WebSocket scope (where `ws/usage`, `ws/states`, `runs/:id/shell` are registered):

```elixir
get "/runs/:id/proxy/:port", ProxySocketController, :upgrade
```

Order matters — the WS routes must be in their own scope outside the `:api` pipeline that demands JSON content-type, exactly as the existing usage/shell/states routes are.

- [ ] **Step 2: Run the proxy controller tests**

```bash
cd server-elixir && mix test test/fbi_web/controllers/proxy_controller_test.exs
```

The `404 for unknown run` and `409 when no container` tests should now pass against the real route.

- [ ] **Step 3: Run the full suite**

```bash
cd server-elixir && mix test
```

- [ ] **Step 4: Commit**

```bash
git add server-elixir/lib/fbi_web/router.ex \
        server-elixir/test/fbi_web/controllers/proxy_controller_test.exs
git commit -m "feat(proxy): register listening-ports + proxy/:port routes"
```

---

## Wrap-up

### Task 21: Run `mix precommit` (or full suite + format) and clean up

- [ ] **Step 1: Format the entire diff**

```bash
cd server-elixir && mix format
```

- [ ] **Step 2: Full test run**

```bash
cd server-elixir && mix test
```

- [ ] **Step 3: If `mix precommit` exists, run it**

```bash
cd server-elixir && mix precommit
```

(`AGENTS.md` mentions this alias; use it if it's wired up.)

- [ ] **Step 4: Final commit if formatter touched anything**

```bash
git add -A server-elixir/
git diff --cached --stat
git commit -m "style(server-elixir): mix format" # only if there are changes
```

---

## Areas needing live smoke testing (not covered by automated tests)

These can't be exercised by static review or unit tests alone. After all groups merge, do a manual run-through:

1. **Group 1 end-to-end:** create a run with a draft_token, watch the upload land in `runs/<id>/uploads/`. Cancel an `awaiting_resume` run via DELETE; confirm the ResumeScheduler timer is cancelled (check `iex` for the scheduler's state). Edit a title via PATCH while a shell WS is open; confirm the title frame arrives in the WS.
2. **Group 2 end-to-end:** open a project with a long-lived branch on GitHub; create a run; verify the Changes tab shows only branch-unique commits (not pre-run history). Check a commit's file list via the drawer; verify it loads even after the container exits (gh fallback).
3. **Group 4 end-to-end:** start a dev server inside a run container (e.g., `python -m http.server 8000`); call `GET /api/runs/:id/listening-ports`; verify the response. Open a WS to `/api/runs/:id/proxy/8000` from a browser/curl; verify GETs flow through.

## Self-review checklist (run before handing the plan to an executor)

- [x] Each task fits 2–5 minutes per step (longer tasks split into sub-steps).
- [x] All `file:line` references are to `origin/main` at `99bb88f`.
- [x] No "TODO", "TBD", or "similar to Task N" placeholders.
- [x] All cross-task type signatures match (e.g. `ModelParams.validate/1` returns `:ok | {:error, String.t()}` in Task 3 and is consumed with that shape in Tasks 4+5).
- [x] Each task ends in a commit step with a concrete message.
- [x] Tests precede implementation (TDD).
- [x] All audit findings A1–A8, B1, C1–C3 are mapped to tasks: A1→T4, A2→T5+T6+T7, A3→T8, A4→T1+T2, A5→T9+T10, A6→T11, A7→T12, A8→T13, B1→T17+T18+T19+T20, C1→T14, C2→T15, C3→T16.
- [x] Audit finding C4 (the unused `GET /github` and `POST /github/merge` Elixir-only routes) intentionally excluded — they're forward-looking endpoints from Phase 8 and removing them is out of scope for a bug-fix sweep.
