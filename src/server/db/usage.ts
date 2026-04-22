import type { DB } from './index.js';
import type { UsageSnapshot, RateLimitSnapshot } from '../../shared/types.js';

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
}
