import type { DB } from './index.js';
import type { UsageError } from '../../shared/types.js';

export interface RateLimitStateRow {
  plan: 'pro' | 'max' | 'team' | null;
  observed_at: number | null;
  last_error: UsageError;
  last_error_at: number | null;
}

export class RateLimitStateRepo {
  constructor(private db: DB) {
    // Ensure seed row exists so every op can UPDATE safely.
    this.db.prepare('INSERT OR IGNORE INTO rate_limit_state (id) VALUES (1)').run();
  }

  get(): RateLimitStateRow {
    const row = this.db.prepare(
      'SELECT plan, observed_at, last_error, last_error_at FROM rate_limit_state WHERE id = 1'
    ).get() as RateLimitStateRow | undefined;
    return row ?? { plan: null, observed_at: null, last_error: null, last_error_at: null };
  }

  setObserved(now: number): void {
    this.db.prepare(
      'UPDATE rate_limit_state SET observed_at = ?, last_error = NULL, last_error_at = NULL WHERE id = 1'
    ).run(now);
  }

  setError(kind: Exclude<UsageError, null>, now: number): void {
    this.db.prepare(
      'UPDATE rate_limit_state SET last_error = ?, last_error_at = ? WHERE id = 1'
    ).run(kind, now);
  }

  setPlan(plan: 'pro' | 'max' | 'team'): void {
    this.db.prepare('UPDATE rate_limit_state SET plan = ? WHERE id = 1').run(plan);
  }
}
