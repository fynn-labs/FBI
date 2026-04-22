import type { RunsRepo } from '../db/runs.js';

export interface ResumeSchedulerDeps {
  runs: RunsRepo;
  /** Invoked when a timer fires; never from within a setTimeout callback that holds a lock. */
  onFire: (runId: number) => Promise<void> | void;
}

export class ResumeScheduler {
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(private deps: ResumeSchedulerDeps) {}

  schedule(runId: number, fireAt: number): void {
    this.cancel(runId);
    const delay = Math.max(0, fireAt - Date.now());
    const t = setTimeout(() => {
      this.timers.delete(runId);
      void this.fire(runId);
    }, delay);
    this.timers.set(runId, t);
  }

  cancel(runId: number): void {
    const t = this.timers.get(runId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(runId);
    }
  }

  fireNow(runId: number): void {
    this.cancel(runId);
    setTimeout(() => { void this.fire(runId); }, 0);
  }

  cancelAll(): void {
    for (const [id] of this.timers) this.cancel(id);
  }

  async rehydrate(): Promise<void> {
    const rows = this.deps.runs.listAwaiting();
    for (const row of rows) {
      this.schedule(row.id, row.next_resume_at ?? 0);
    }
  }

  private async fire(runId: number): Promise<void> {
    try {
      await this.deps.onFire(runId);
    } catch {
      // Caller's responsibility to mark the run failed; swallow here.
    }
  }
}
