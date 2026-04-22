import type { DB } from './index.js';
import type { Run, RunState } from '../../shared/types.js';

export interface CreateRunInput {
  project_id: number;
  prompt: string;
  branch_name_tmpl: (id: number) => string;
  log_path_tmpl: (id: number) => string;
}

export interface FinishInput {
  state: Extract<RunState, 'succeeded' | 'failed' | 'cancelled'>;
  exit_code?: number | null;
  error?: string | null;
  head_commit?: string | null;
}

export class RunsRepo {
  constructor(private db: DB) {}

  create(input: CreateRunInput): Run {
    return this.db.transaction(() => {
      const now = Date.now();
      const stub = this.db
        .prepare(
          `INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at)
           VALUES (?, ?, '', 'queued', '', ?)`
        )
        .run(input.project_id, input.prompt, now);
      const id = Number(stub.lastInsertRowid);
      const branch = input.branch_name_tmpl(id);
      const logPath = input.log_path_tmpl(id);
      this.db
        .prepare('UPDATE runs SET branch_name = ?, log_path = ? WHERE id = ?')
        .run(branch, logPath, id);
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

  markFinished(id: number, f: FinishInput): void {
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

  delete(id: number): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }
}
