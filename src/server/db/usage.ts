import type { DB } from './index.js';
import type { UsageSnapshot, RateLimitSnapshot, DailyUsage, RunUsageBreakdownRow } from '../../shared/types.js';

// TODO(task-4 / task-10): drop `rate_limit` and rl_* column writes once
// orchestrator and /api/usage stop passing them.
export interface InsertUsageEventInput {
  run_id: number;
  ts: number;
  snapshot: UsageSnapshot;
  rate_limit: RateLimitSnapshot | null;
}

export class UsageRepo {
  constructor(private db: DB) {}

  insertUsageEvent(input: InsertUsageEventInput): void {
    const s = input.snapshot;
    const rl = input.rate_limit;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO run_usage_events
             (run_id, ts, model, input_tokens, output_tokens,
              cache_read_tokens, cache_create_tokens,
              rl_requests_remaining, rl_requests_limit,
              rl_tokens_remaining, rl_tokens_limit, rl_reset_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.run_id, input.ts, s.model,
          s.input_tokens, s.output_tokens,
          s.cache_read_tokens, s.cache_create_tokens,
          rl?.requests_remaining ?? null,
          rl?.requests_limit ?? null,
          rl?.tokens_remaining ?? null,
          rl?.tokens_limit ?? null,
          rl?.reset_at ?? null
        );
      this.db
        .prepare(
          `UPDATE runs SET
             tokens_input        = tokens_input        + ?,
             tokens_output       = tokens_output       + ?,
             tokens_cache_read   = tokens_cache_read   + ?,
             tokens_cache_create = tokens_cache_create + ?,
             tokens_total        = tokens_total        + ?
           WHERE id = ?`
        )
        .run(
          s.input_tokens, s.output_tokens,
          s.cache_read_tokens, s.cache_create_tokens,
          s.input_tokens + s.output_tokens,   // billable only (was: all four sums including cache)
          input.run_id
        );
    })();
  }

  bumpParseErrors(runId: number): void {
    this.db.prepare('UPDATE runs SET usage_parse_errors = usage_parse_errors + 1 WHERE id = ?').run(runId);
  }

  listDailyUsage(input: { days: number; now: number }): DailyUsage[] {
    const days = Math.max(1, Math.min(90, input.days));
    const sinceMs = input.now - days * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT DATE(ts/1000, 'unixepoch', 'localtime') AS date,
                SUM(input_tokens + output_tokens) AS tokens_total,
                SUM(input_tokens)        AS tokens_input,
                SUM(output_tokens)       AS tokens_output,
                SUM(cache_read_tokens)   AS tokens_cache_read,
                SUM(cache_create_tokens) AS tokens_cache_create,
                COUNT(DISTINCT run_id)   AS run_count
           FROM run_usage_events
          WHERE ts >= ?
          GROUP BY date
          ORDER BY date ASC`
      )
      .all(sinceMs) as Array<{
        date: string;
        tokens_total: number; tokens_input: number; tokens_output: number;
        tokens_cache_read: number; tokens_cache_create: number;
        run_count: number;
      }>;
    return rows;
  }

  getRunBreakdown(runId: number): RunUsageBreakdownRow[] {
    return this.db
      .prepare(
        `SELECT model,
                SUM(input_tokens)        AS input,
                SUM(output_tokens)       AS output,
                SUM(cache_read_tokens)   AS cache_read,
                SUM(cache_create_tokens) AS cache_create
           FROM run_usage_events
          WHERE run_id = ?
          GROUP BY model
          ORDER BY model ASC`
      )
      .all(runId) as RunUsageBreakdownRow[];
  }
}
