import type { DB } from './index.js';

export interface RateLimitSnapshot {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;
  observed_at: number;
  observed_from_run_id: number | null;
}

export class RateLimitStateRepo {
  constructor(private db: DB) {}

  get(): RateLimitSnapshot | null {
    const row = this.db.prepare('SELECT * FROM rate_limit_state WHERE id = 1').get() as
      | RateLimitSnapshot
      | undefined;
    return row ?? null;
  }

  upsert(s: RateLimitSnapshot): void {
    this.db.prepare(
      `INSERT INTO rate_limit_state
         (id, requests_remaining, requests_limit, tokens_remaining, tokens_limit,
          reset_at, observed_at, observed_from_run_id)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         requests_remaining = excluded.requests_remaining,
         requests_limit     = excluded.requests_limit,
         tokens_remaining   = excluded.tokens_remaining,
         tokens_limit       = excluded.tokens_limit,
         reset_at           = excluded.reset_at,
         observed_at        = excluded.observed_at,
         observed_from_run_id = excluded.observed_from_run_id
       WHERE excluded.observed_at > rate_limit_state.observed_at`,
    ).run(
      s.requests_remaining, s.requests_limit, s.tokens_remaining, s.tokens_limit,
      s.reset_at, s.observed_at, s.observed_from_run_id,
    );
  }
}
