import type { DB } from './index.js';
import type { UsageSnapshot, RateLimitSnapshot, RateLimitState, DailyUsage, RunUsageBreakdownRow } from '../../shared/types.js';

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
          s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_create_tokens,
          input.run_id
        );
    })();
  }

  bumpParseErrors(runId: number): void {
    this.db.prepare('UPDATE runs SET usage_parse_errors = usage_parse_errors + 1 WHERE id = ?').run(runId);
  }

  upsertRateLimitState(input: {
    observed_at: number;
    observed_from_run_id: number | null;
    snapshot: RateLimitSnapshot;
  }): void {
    const s = input.snapshot;
    // Guard: only apply if newer than any existing observation.
    this.db
      .prepare(
        `INSERT INTO rate_limit_state
           (id, requests_remaining, requests_limit,
            tokens_remaining, tokens_limit, reset_at,
            observed_at, observed_from_run_id)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           requests_remaining = excluded.requests_remaining,
           requests_limit     = excluded.requests_limit,
           tokens_remaining   = excluded.tokens_remaining,
           tokens_limit       = excluded.tokens_limit,
           reset_at           = excluded.reset_at,
           observed_at        = excluded.observed_at,
           observed_from_run_id = excluded.observed_from_run_id
         WHERE excluded.observed_at > rate_limit_state.observed_at`
      )
      .run(
        s.requests_remaining, s.requests_limit,
        s.tokens_remaining, s.tokens_limit, s.reset_at,
        input.observed_at, input.observed_from_run_id
      );
  }

  listDailyUsage(input: { days: number; now: number }): DailyUsage[] {
    const days = Math.max(1, Math.min(90, input.days));
    const sinceMs = input.now - days * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT DATE(ts/1000, 'unixepoch', 'localtime') AS date,
                SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS tokens_total,
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

  getRateLimitState(now: number): RateLimitState {
    const row = this.db
      .prepare('SELECT * FROM rate_limit_state WHERE id = 1')
      .get() as
      | {
          requests_remaining: number | null;
          requests_limit: number | null;
          tokens_remaining: number | null;
          tokens_limit: number | null;
          reset_at: number | null;
          observed_at: number | null;
          observed_from_run_id: number | null;
        }
      | undefined;

    if (!row) {
      return {
        requests_remaining: null, requests_limit: null,
        tokens_remaining: null, tokens_limit: null,
        reset_at: null, observed_at: null, observed_from_run_id: null,
        percent_used: null, reset_in_seconds: null, observed_seconds_ago: null,
      };
    }

    const percent_used = deriveUsed(row.requests_remaining, row.requests_limit)
      ?? deriveUsed(row.tokens_remaining, row.tokens_limit);
    const reset_in_seconds = row.reset_at != null
      ? Math.max(0, Math.floor((row.reset_at - now) / 1000))
      : null;
    const observed_seconds_ago = row.observed_at != null
      ? Math.max(0, Math.floor((now - row.observed_at) / 1000))
      : null;

    return {
      requests_remaining: row.requests_remaining,
      requests_limit: row.requests_limit,
      tokens_remaining: row.tokens_remaining,
      tokens_limit: row.tokens_limit,
      reset_at: row.reset_at,
      observed_at: row.observed_at,
      observed_from_run_id: row.observed_from_run_id,
      percent_used,
      reset_in_seconds,
      observed_seconds_ago,
    };
  }
}

function deriveUsed(remaining: number | null, limit: number | null): number | null {
  if (remaining == null || limit == null || limit <= 0) return null;
  return Math.max(0, Math.min(1, (limit - remaining) / limit));
}
