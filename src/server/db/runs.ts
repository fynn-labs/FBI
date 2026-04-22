import type { DB } from './index.js';
import type { Run, RunState } from '../../shared/types.js';

export interface CreateRunInput {
  project_id: number;
  prompt: string;
  branch_hint?: string;
  log_path_tmpl: (id: number) => string;
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
          `INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at)
           VALUES (?, ?, ?, 'queued', '', ?)`
        )
        .run(input.project_id, input.prompt, branchHint, now);
      const id = Number(stub.lastInsertRowid);
      const logPath = input.log_path_tmpl(id);
      this.db
        .prepare('UPDATE runs SET log_path = ? WHERE id = ?')
        .run(logPath, id);
      return this.get(id)!;
    })();
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

  markStarted(id: number, containerId: string): void {
    this.db
      .prepare(
        "UPDATE runs SET state='running', container_id=?, started_at=? WHERE id=?"
      )
      .run(containerId, Date.now(), id);
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
                resume_attempts = resume_attempts + 1
          WHERE id=?`,
      )
      .run(p.next_resume_at, p.last_limit_reset_at, id);
  }

  markResuming(id: number, containerId: string): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='running',
                container_id=?,
                next_resume_at=NULL,
                started_at=COALESCE(started_at, ?)
          WHERE id=?`,
      )
      .run(containerId, Date.now(), id);
  }

  markContinuing(id: number, containerId: string): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='running',
                container_id=?,
                resume_attempts=0,
                next_resume_at=NULL,
                finished_at=NULL,
                exit_code=NULL,
                error=NULL,
                started_at=COALESCE(started_at, ?)
          WHERE id=? AND state IN ('failed','cancelled','succeeded')`,
      )
      .run(containerId, Date.now(), id);
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

  listAwaiting(): Array<Pick<Run, 'id' | 'next_resume_at'>> {
    return this.db
      .prepare(
        `SELECT id, next_resume_at FROM runs WHERE state='awaiting_resume'`,
      )
      .all() as Array<Pick<Run, 'id' | 'next_resume_at'>>;
  }

  markFinished(id: number, f: FinishInput): void {
    if (f.branch_name !== undefined && f.branch_name !== null && f.branch_name !== '') {
      this.db
        .prepare('UPDATE runs SET branch_name = ? WHERE id = ?')
        .run(f.branch_name, id);
    }
    this.db
      .prepare(
        `UPDATE runs SET state=?, container_id=NULL, exit_code=?, error=?,
         head_commit=?, finished_at=? WHERE id=?`
      )
      .run(
        f.state,
        f.exit_code ?? null,
        f.error ?? null,
        f.head_commit ?? null,
        Date.now(),
        id
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
}
