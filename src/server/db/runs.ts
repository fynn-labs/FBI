import type { DB } from './index.js';
import type { MirrorStatus, Run, RunState } from '../../shared/types.js';

export interface CreateRunInput {
  project_id: number;
  prompt: string;
  branch_hint?: string;
  log_path_tmpl: (id: number) => string;
  parent_run_id?: number;
  kind?: 'work' | 'merge-conflict' | 'polish';
  kind_args_json?: string;
  model?: string | null;
  effort?: string | null;
  subagent_model?: string | null;
}

export interface ListFilteredInput {
  state?: RunState;
  project_id?: number;
  q?: string;
  limit: number;
  offset: number;
}

export interface FinishInput {
  state: Extract<RunState, 'succeeded' | 'failed' | 'cancelled'>;
  exit_code?: number | null;
  error?: string | null;
  head_commit?: string | null;
  branch_name?: string | null;
}

export class RunsRepo {
  constructor(private db: DB) {}

  create(input: CreateRunInput): Run {
    return this.db.transaction(() => {
      const now = Date.now();
      const branchHint = input.branch_hint ?? '';
      const stub = this.db
        .prepare(
          `INSERT INTO runs
             (project_id, prompt, branch_name, state, log_path,
              created_at, state_entered_at,
              parent_run_id, kind, kind_args_json,
              model, effort, subagent_model)
           VALUES (?, ?, ?, 'queued', '', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.project_id,
          input.prompt,
          branchHint,
          now,
          now,
          input.parent_run_id ?? null,
          input.kind ?? 'work',
          input.kind_args_json ?? null,
          input.model ?? null,
          input.effort ?? null,
          input.subagent_model ?? null,
        );
      const id = Number(stub.lastInsertRowid);
      const logPath = input.log_path_tmpl(id);
      this.db
        .prepare('UPDATE runs SET log_path = ? WHERE id = ?')
        .run(logPath, id);
      return this.get(id)!;
    })();
  }

  updateModelParams(
    id: number,
    p: { model: string | null; effort: string | null; subagent_model: string | null },
  ): void {
    this.db
      .prepare('UPDATE runs SET model = ?, effort = ?, subagent_model = ? WHERE id = ?')
      .run(p.model, p.effort, p.subagent_model, id);
  }

  get(id: number): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Run
      | undefined;
  }

  listByProject(projectId: number, limit = 50): Run[] {
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(projectId, limit) as Run[];
  }

  listByState(state: RunState, limit = 100): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE state = ? ORDER BY created_at DESC LIMIT ?')
      .all(state, limit) as Run[];
  }

  listAll(limit = 100): Run[] {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Run[];
  }

  listRecentPrompts(
    projectId: number,
    limit = 10
  ): { prompt: string; last_used_at: number; run_id: number }[] {
    return this.db
      .prepare(
        `SELECT prompt,
                MAX(created_at) AS last_used_at,
                MAX(id)         AS run_id
           FROM runs
          WHERE project_id = ?
          GROUP BY prompt
          ORDER BY last_used_at DESC, run_id DESC
          LIMIT ?`
      )
      .all(projectId, limit) as {
        prompt: string;
        last_used_at: number;
        run_id: number;
      }[];
  }

  /**
   * Fresh launch: queued -> starting. Records container id and started_at.
   * RuntimeStateWatcher will later transition starting -> running once the
   * `prompted` sentinel appears (Claude read the initial prompt).
   */
  markStartingFromQueued(id: number, containerId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs
            SET state='starting',
                container_id=?,
                started_at=?,
                state_entered_at=?
          WHERE id=? AND state='queued'`,
      )
      .run(containerId, now, now, id);
  }

  markAwaitingResume(
    id: number,
    p: { next_resume_at: number; last_limit_reset_at: number | null },
  ): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='awaiting_resume',
                container_id=NULL,
                next_resume_at=?,
                last_limit_reset_at=?,
                resume_attempts = resume_attempts + 1,
                state_entered_at=?
          WHERE id=? AND state IN ('starting','running','waiting')`,
      )
      .run(p.next_resume_at, p.last_limit_reset_at, Date.now(), id);
  }

  /**
   * Auto-resume: awaiting_resume -> starting. Preserves resume_attempts
   * (markAwaitingResume already incremented it).
   */
  markStartingForResume(id: number, containerId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs
            SET state='starting',
                container_id=?,
                next_resume_at=NULL,
                started_at=COALESCE(started_at, ?),
                state_entered_at=?
          WHERE id=? AND state='awaiting_resume'`,
      )
      .run(containerId, now, now, id);
  }

  /**
   * User-initiated Continue, first call (from API endpoint). No container
   * exists yet. Resets resume_attempts and clears terminal-run residue.
   */
  markStartingForContinueRequest(id: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs
            SET state='starting',
                resume_attempts=0,
                next_resume_at=NULL,
                finished_at=NULL,
                exit_code=NULL,
                error=NULL,
                state_entered_at=?
          WHERE id=? AND state IN ('failed','cancelled','succeeded')`,
      )
      .run(now, id);
  }

  /**
   * User-initiated Continue, second call (from orchestrator after the
   * container exists). Records container id and refreshes state_entered_at.
   * Source-state guard is 'starting' — markStartingForContinueRequest must
   * have run first.
   */
  markStartingContainer(id: number, containerId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs
            SET container_id=?,
                started_at=COALESCE(started_at, ?),
                state_entered_at=?
          WHERE id=? AND state='starting'`,
      )
      .run(containerId, now, now, id);
  }

  markWaiting(id: number): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='waiting', state_entered_at=?
          WHERE id=? AND state IN ('starting','running')`,
      )
      .run(Date.now(), id);
  }

  /**
   * RuntimeStateWatcher saw the `prompted` sentinel: Claude is processing
   * a prompt. Allowed from 'starting' (initial launch) or 'waiting'
   * (subsequent reply).
   */
  markRunning(id: number): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='running', state_entered_at=?
          WHERE id=? AND state IN ('starting','waiting')`,
      )
      .run(Date.now(), id);
  }

  setClaudeSessionId(id: number, sessionId: string): void {
    this.db
      .prepare(
        `UPDATE runs
            SET claude_session_id=?
          WHERE id=? AND claude_session_id IS NULL`,
      )
      .run(sessionId, id);
  }

  updateTitle(
    id: number,
    title: string,
    opts: { lock?: boolean; respectLock: boolean },
  ): void {
    const trimmed = title.trim().slice(0, 80);
    if (trimmed.length === 0) return;
    if (opts.respectLock) {
      this.db
        .prepare(`UPDATE runs SET title = ? WHERE id = ? AND title_locked = 0`)
        .run(trimmed, id);
    } else {
      const lockVal = opts.lock ? 1 : 0;
      this.db
        .prepare('UPDATE runs SET title = ?, title_locked = ? WHERE id = ?')
        .run(trimmed, lockVal, id);
    }
  }

  listAwaiting(): Array<Pick<Run, 'id' | 'next_resume_at'>> {
    return this.db
      .prepare(
        `SELECT id, next_resume_at FROM runs WHERE state='awaiting_resume'`,
      )
      .all() as Array<Pick<Run, 'id' | 'next_resume_at'>>;
  }

  updateLastLimitResetAt(id: number, resetAt: number): void {
    this.db.prepare('UPDATE runs SET last_limit_reset_at = ? WHERE id = ?').run(resetAt, id);
  }

  markResumeFailed(id: number, error: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs SET state='resume_failed', container_id=NULL, error=?,
         finished_at=?, state_entered_at=? WHERE id=?`
      )
      .run(error, now, now, id);
  }

  markFinished(id: number, f: FinishInput): void {
    if (f.branch_name !== undefined && f.branch_name !== null && f.branch_name !== '') {
      this.db
        .prepare('UPDATE runs SET branch_name = ? WHERE id = ?')
        .run(f.branch_name, id);
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs SET state=?, container_id=NULL, exit_code=?, error=?,
         head_commit=?, finished_at=?, state_entered_at=? WHERE id=?`
      )
      .run(
        f.state,
        f.exit_code ?? null,
        f.error ?? null,
        f.head_commit ?? null,
        now,
        now,
        id,
      );
  }

  listFiltered(input: ListFilteredInput): { items: Run[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.state) { where.push('state = ?'); params.push(input.state); }
    if (typeof input.project_id === 'number') { where.push('project_id = ?'); params.push(input.project_id); }
    if (input.q && input.q.trim() !== '') {
      where.push('LOWER(prompt) LIKE ?');
      params.push('%' + input.q.trim().toLowerCase() + '%');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs ${whereSql}`)
      .get(...params) as { n: number }).n;

    const items = this.db
      .prepare(`SELECT * FROM runs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, input.limit, input.offset) as Run[];

    return { items, total };
  }

  listByParent(parentRunId: number): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY id ASC')
      .all(parentRunId) as Run[];
  }

  listSiblings(runId: number, limit = 10): Run[] {
    const self = this.get(runId);
    if (!self) return [];
    return this.db
      .prepare(
        `SELECT * FROM runs
          WHERE project_id = ? AND prompt = ? AND id != ?
          ORDER BY id DESC LIMIT ?`
      )
      .all(self.project_id, self.prompt, self.id, limit) as Run[];
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  setBaseBranch(id: number, baseBranch: string | null): void {
    this.db.prepare('UPDATE runs SET base_branch = ? WHERE id = ?')
      .run(baseBranch, id);
  }

  setBranchName(id: number, name: string): void {
    this.db.prepare('UPDATE runs SET branch_name = ? WHERE id = ?').run(name, id);
  }

  setMirrorStatus(id: number, status: MirrorStatus): void {
    this.db.prepare('UPDATE runs SET mirror_status = ? WHERE id = ?')
      .run(status, id);
  }

  listActiveByBranch(projectId: number, branchName: string): Run[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
          WHERE project_id = ? AND branch_name = ?
            AND state NOT IN ('succeeded','failed','cancelled','resume_failed')
          ORDER BY id DESC`
      )
      .all(projectId, branchName) as Run[];
  }
}
