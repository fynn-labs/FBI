# FBI — Feature Gaps

**Purpose:** Running backlog of gaps identified against the shipped v1 runtime slice.
Work through categories one at a time: brainstorm → spec → plan → implement → mark shipped here.

**Priority legend:**
- **P1** — painful for daily single-user flow, fix soon
- **P2** — "you'll want this soon"
- **P3** — nice-to-have, or explicit non-goal in the v1 spec

**Status legend:** `todo` · `specing` (design in progress) · `planned` (plan written) · `in-progress` · `shipped` · `wontfix`

---

## Suggested working order

1. **A. Run iteration & reuse** — biggest lift per unit effort; reshapes the tool
2. **B. Visibility & post-run signal** — completion notifications especially
3. **F. Prompt composition transparency** — small, ships fast, unlocks A and B
4. **C. Filtering & scale** — gets painful around run #50
5. **D. Safety & limits** — quiet risks, worth addressing before an incident
6. **E. Completion & workflow** — auto-PR is the natural next click
7. **G. Operability** — SSH-free admin is a late-stage polish
8. **H. Non-goals** — only revisit if scope shifts

---

## A. Run iteration & reuse

**Status:** shipped (P1s) · todo (P2)
**Spec:** [`2026-04-21-p1-improvements-design.md`](superpowers/specs/2026-04-21-p1-improvements-design.md) §2, §3 (P1s only)

- [x] **(P1) Follow-up run on the same branch.** Reframed during brainstorming: Claude owns branch naming, follow-up collapses to "new run with pre-filled branch field." See spec §2.
- [x] **(P1) Prompt history / templates.** Spec'd as history-only: "Recent prompts" dropdown on NewRun, top N distinct prompts per project, no new table. See spec §3.
- [ ] **(P2) Run comparison.** Two runs from the same prompt → no side-by-side of what each did.

---

## B. Visibility & post-run signal

**Status:** shipped (P1) · todo (P2, P3)
**Spec:** [`2026-04-21-p1-improvements-design.md`](superpowers/specs/2026-04-21-p1-improvements-design.md) §4 (P1 only)

- [x] **(P1) Run-completion notification.** Spec'd: Browser Notification API + tab title prefix + favicon dot, global watcher via 5s poll, Settings toggle. See spec §4.
- [ ] **(P2) "What's running now" on the home page.** `/` lists projects with name+repo; no visibility into which projects have active runs without clicking through.
- [ ] **(P2) PR / CI / branch-status surfacing.** No "did CI pass on the pushed branch?" or "has a PR been opened against this branch?" Post-run lives entirely on GitHub.
- [ ] **(P2) File-level diff summary on the run page.** You go click out to GitHub for every post-mortem.
- [ ] **(P3) Duration / token / cost metrics.** Explicit non-goal, but the absence compounds over time.

---

## C. Filtering & scale

**Status:** todo

- [ ] **(P2) `/runs` filters, search, pagination.** API accepts a `state` filter (spec §6) but the UI doesn't expose it. 50 runs in, this page is useless.
- [ ] **(P2) `/projects` shows last-run state/time.** Spec §7 says project cards should include this; `Projects.tsx` doesn't render it yet.
- [ ] **(P3) Tags / labels on runs** for triage.

---

## D. Safety & limits

**Status:** shipped (P1) · todo (P2)
**Spec:** [`2026-04-21-p1-improvements-design.md`](superpowers/specs/2026-04-21-p1-improvements-design.md) §5 (P1 only)

- [x] **(P1) Resource caps per container** (cpu/mem/pids). Spec'd: global env defaults + nullable per-project override, enforced via Docker HostConfig, OOM surfaced as a specific error. See spec §5.
- [ ] **(P2) Concurrency / queue cap.** Spec §3 explicitly says no cap in v1 — a choice, not a bug — but a soft cap ("you already have 5 running — are you sure?") is cheap protection.
- [ ] **(P2) Image GC.** Listed as future work. Over months, disk fills silently.

---

## E. Completion & workflow

**Status:** todo

- [ ] **(P2) Auto-PR / one-click "open PR on GitHub."** Spec defers this (§11), but it's the natural next click after every successful run.
- [ ] **(P3) Webhook / scheduled triggers.** Explicit non-goal (spec §2).
- [ ] **(P3) "Reply to PR comment → start run"** integration.

---

## F. Prompt composition transparency

**Status:** todo

- [ ] **(P2) Composed-prompt preview.** Global + project instructions + run prompt get concatenated by `supervisor.sh`; user can't see the final payload until it appears in the terminal output.
- [ ] **(P2) Effective plugins/marketplaces preview.** Show which will actually be installed for this run before starting (global ∪ project, deduped).

---

## G. Operability

**Status:** todo

- [ ] **(P3) In-app health/admin page** (Docker daemon OK? image cache size? disk?). Today you SSH in.
- [ ] **(P3) `DELETE /api/runs/:id` on a running run is silent cancel.** See `src/server/api/runs.ts:47-54` — finished runs get deleted, running runs get cancelled with no row removal. UX surprise worth at least making explicit in the UI.

---

## H. Explicit non-goals worth sanity-checking

**Status:** wontfix (unless scope shifts)

Spec §2 and §11 mark these out-of-scope. Listed here so they're one place to find:
- Multi-user / RBAC
- Auto-PR creation (duplicated in E — promote if prioritized)
- Run retry / resume / chaining
- In-app diff viewer (duplicated in B — promote if prioritized)
- Mobile UI
- Webhooks, scheduled triggers
- Cross-project templates
- Pluggable runtime / image-build backends
- Pre-run "exec into container without running Claude"
- Per-task ephemeral deploy keys (currently: host SSH agent forwarding)

---

## Changelog

- 2026-04-21 — doc created; findings from post-v1 evaluation
- 2026-04-21 — all four P1s spec'd in `superpowers/specs/2026-04-21-p1-improvements-design.md` (A: branch autonomy + recent prompts; B: completion notifications; D: resource caps)
- 2026-04-21 — P1 pack shipped; branch autonomy, recent prompts, notifications, and resource caps live.
