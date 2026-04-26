# TS → Elixir orchestrator parity audit (run launch path)

**Date:** 2026-04-25
**Scope:** Container spec construction + post-create injection + watchers
started during run launch.
**Sources audited:**
- `src/server/orchestrator/index.ts` (TS, source of truth)
- `server-elixir/lib/fbi/orchestrator/run_server.ex` (Elixir port)
- supporting helpers in both trees (`safeguardBind.ts`,
  `branchNameWatcher.ts`, `claudeJson.ts`, `gitAuth.ts`)

**Method:** field-by-field comparison, looking for things present in
the TS path that were silently dropped or constructed differently in
the Elixir port. This is the audit triggered after we hit three
different "TS does X, elixir doesn't" bugs in one session
(`skipDangerousModePermissionPrompt` + hooks; `HostConfig.GroupAdd`;
`ANTHROPIC_MODEL` env vars).

**Result:** 6 additional gaps. Two are silent functional regressions
that affect every run today.

---

## Critical — silent functional regression

### 1. Safeguard mount path is wrong

TS bind (`safeguardBind.ts:13`):

    <runsDir>/<id>/wip.git:/safeguard:rw

Elixir bind (`run_server.ex:1018`):

    <wip_path>:/home/agent/.safeguard.git:rw

`supervisor.sh` (identical in both ports) expects the bind at
`/safeguard`:

```sh
git remote add safeguard /safeguard \
    || git remote set-url safeguard /safeguard \
    || { _fbi_fatal "could not register safeguard remote"; exit 14; }
…
git push safeguard "HEAD:refs/heads/$MIRROR" > /tmp/last-safeguard-push.log 2>&1 \
    || echo "fatal: safeguard push failed" >&2
```

So with the elixir port:

- `git remote add safeguard /safeguard` fails (no such directory — the
  bind-mount is at `/home/agent/.safeguard.git`, not `/safeguard`)
- supervisor.sh's `||` chain logs the error to stderr but **does not
  exit** — it continues, runs the agent, completes the run
- `git push safeguard …` later fails identically and is also only
  logged

**Effect:** the durable safeguard mirror — the system's main
crash-recovery / WIP-preservation mechanism — is broken. Runs appear
to succeed, but the safeguard ref never gets pushed, so resume /
continue / "recover work from crashed run" all silently lose work.

**Fix:** change the elixir bind to `/safeguard:rw`. One-line change.

`fbi-history-op.sh` also references `/safeguard` (line 61-63) — same
fix benefits both.

### 2. `/fbi/uploads:ro` bind-mount is missing entirely

TS (`index.ts:289`):

    `${toBindHost(this.ensureUploadsDir(runId))}:/fbi/uploads:ro`

Elixir (`run_server.ex:1014-1020`): not in the binds list. The
uploads directory is created (`run_server.ex:270`:
`_uploads_dir = ensure_dir(SessionId.uploads_dir(runs_dir, run_id), 0o755)`)
but never bind-mounted into the container.

**Effect:** files attached to a run via the UI's upload feature land
at `<runsDir>/<id>/uploads/` on the host, but `/fbi/uploads` doesn't
exist inside the container. Any agent that tries to read uploaded
files gets ENOENT.

**Fix:** add the bind-mount entry. Mirror TS's `:ro` flag.

---

## High — functional regression

### 3. `FBI_MARKETPLACES` and `FBI_PLUGINS` ignore global settings

TS (`index.ts:231-232, 256-257`):

```ts
const marketplaces = uniq([...settingsData.global_marketplaces, ...project.marketplaces]);
const plugins = uniq([...settingsData.global_plugins, ...project.plugins]);
…
`FBI_MARKETPLACES=${marketplaces.join('\n')}`,
`FBI_PLUGINS=${plugins.join('\n')}`,
```

Elixir (`run_server.ex:1001-1002`):

```elixir
"FBI_MARKETPLACES=#{Enum.join(project.marketplaces || [], "\n")}",
"FBI_PLUGINS=#{Enum.join(project.plugins || [], "\n")}",
```

**Effect:** Claude Code plugins / marketplaces configured globally in
`/etc/default/fbi-elixir` (`FBI_DEFAULT_PLUGINS=…`) or on the global
settings page are never installed in the container. Only
project-scoped lists work. The default install ships with
`FBI_DEFAULT_PLUGINS=superpowers@claude-plugins-official` — that
plugin currently isn't being installed.

**Fix:** call `FBI.Settings.Queries.get/0` (already returns
`global_marketplaces` and `global_plugins` as decoded lists), union
with `project.marketplaces` / `project.plugins`, dedupe.

### 4. `BranchNameWatcher` was never ported

TS (`branchNameWatcher.ts` exists; started in `index.ts:471`):

```ts
branchNameWatcher = new BranchNameWatcher({
  path: `${this.stateDirFor(runId)}/branch-name`,
  pollMs: 1000,
  onBranchName: (name) => { this.deps.runs.setBranchName(runId, name); },
  onError: () => { /* swallow — best effort */ },
});
branchNameWatcher.start();
```

Elixir: no equivalent module. `grep -rn "BranchNameWatcher\|branch_name_watcher\|branch-name"
server-elixir/` returns nothing.

**Effect:** when a run is launched without a user-specified branch,
supervisor.sh + Claude are supposed to choose a branch name and
write it to `/fbi-state/branch-name`. The TS port watches that file
and updates the run's `branch_name` column once Claude picks one. The
elixir port doesn't watch it, so `runs.branch_name` stays NULL even
after Claude writes one — which means downstream code that depends on
it (resume, finalize, github PR creation) is working with a missing
branch name.

**Fix:** port `branchNameWatcher.ts` to a new
`FBI.Orchestrator.BranchNameWatcher` GenServer (mirror
`TitleWatcher`'s shape, which is structurally identical), wire it
into the lifecycle alongside the other watchers via `safe_start/2`.

### 5. `build_preamble/3` always emits the explicit-branch text

TS (`index.ts:312-328`): two-mode preamble.

- **Auto-generated branch** (no user-specified branch): tells Claude
  to pick a 2-4 word kebab-case name, write it to
  `/fbi-state/branch-name`, then `git checkout -b <name>` to rename.
  Mentions `claude/run-N` is a safeguard mirror — don't push to it.
- **Explicit branch**: tells Claude to commit to that branch, don't
  push to others.

Elixir (`run_server.ex:1097-1106`): always emits the explicit-branch
form, with the fallback `claude/run-N` if no branch_name is set.
Misses the entire branch-naming flow.

**Effect:** when a user creates a run without specifying a branch,
Claude doesn't know it's supposed to pick one and write it to
`/fbi-state/branch-name`. So even if BranchNameWatcher (#4) existed,
nothing would write to that file in the first place.

**Fix:** port the conditional logic from TS verbatim. Pairs with #4.

---

## Low — edge case

### 6. `ssh_agent_mounts/1` ignores `host_bind_ssh_auth_sock`

TS (`index.ts:222-224`):

```ts
const auth: GitAuth = new SshAgentForwarding(
  this.deps.config.hostSshAuthSock,
  this.deps.config.hostBindSshAuthSock ?? this.deps.config.hostSshAuthSock,
);
```

Elixir (`run_server.ex:1186-1192`):

```elixir
defp ssh_agent_mounts(config) do
  case config[:host_ssh_auth_sock] do
    nil -> []
    "" -> []
    sock -> ["#{sock}:/ssh-agent"]
  end
end
```

**Effect:** in dev-in-container setups (where the orchestrator runs
in a container and the host's SSH agent socket is at one path on the
host but mounted at a different path inside the orchestrator's
container), the bind-mount source is wrong. Production unaffected
because production runs the orchestrator on the host directly.

**Fix:** use `config[:host_bind_ssh_auth_sock] || config[:host_ssh_auth_sock]`
as the bind source. One-line change.

---

## Things that are correct

For completeness, fields that were checked and match TS:

- Top-level container fields: `Image`, `name`, `User`, `Tty`,
  `OpenStdin`, `StdinOnce`, `Entrypoint` ✓
- `HostConfig.{AutoRemove, Memory, NanoCpus, PidsLimit, Binds,
  GroupAdd}` ✓ (after `3c8aa7b`)
- All env vars: `RUN_ID`, `REPO_URL`, `DEFAULT_BRANCH`,
  `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `IS_SANDBOX`, `FBI_BRANCH`,
  `FBI_RESUME_SESSION_ID`, `SSH_AUTH_SOCK`, project secrets,
  `ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL` ✓ (last three after `2f03ffc`)
- Binds present in both: supervisor.sh, finalizeBranch.sh,
  fbi-history-op.sh, mountDir → `.claude/projects/`, stateDir →
  `/fbi-state/`, claudeAuth credentials, dockerSocket, ssh-agent
  socket ✓
- Post-create file injections: `/fbi/{prompt,instructions,global,preamble}.txt`,
  `/home/agent/.claude.json`, `/home/agent/.claude/settings.json` ✓
  (settings.json contents fixed in `7fcde23`)
- Watchers started: UsageTailer, TitleWatcher, SafeguardWatcher,
  MirrorStatusPoller, RuntimeStateWatcher, LimitMonitor ✓
  (modulo BranchNameWatcher missing per #4)

## Suggested fix order

1. **#1 (safeguard mount path)** — one-line change, unblocks the
   safeguard mirror everyone is implicitly relying on.
2. **#3 (global settings union)** — small, also one-line, fixes
   default plugins not installing.
3. **#2 (uploads bind-mount)** — small, surfaces the upload feature.
4. **#5 (preamble two-mode logic)** — small, port the conditional
   from TS verbatim.
5. **#4 (BranchNameWatcher)** — new GenServer, mirror TitleWatcher's
   shape. Pairs with #5; do them together.
6. **#6 (ssh agent bind source)** — only matters in dev-in-container
   setups; defer.

Items 1-3 are each one-line changes. 4+5 are slightly bigger but
follow patterns already in the codebase.
