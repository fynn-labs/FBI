import type { DB } from './index.js';

export interface RateLimitBucketRow {
  bucket_id: string;
  utilization: number;
  reset_at: number | null;
  window_started_at: number | null;
  last_notified_threshold: number | null;
  last_notified_reset_at: number | null;
  observed_at: number;
}

export interface BucketInput {
  bucket_id: string;
  utilization: number;
  reset_at: number | null;
  window_started_at: number | null;
  observed_at: number;
}

export class RateLimitBucketsRepo {
  constructor(private db: DB) {}

  list(): RateLimitBucketRow[] {
    return this.db.prepare('SELECT * FROM rate_limit_buckets ORDER BY bucket_id ASC').all() as RateLimitBucketRow[];
  }

  upsert(b: BucketInput): void {
    this.db.prepare(
      `INSERT INTO rate_limit_buckets
         (bucket_id, utilization, reset_at, window_started_at, observed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bucket_id) DO UPDATE SET
         utilization       = excluded.utilization,
         reset_at          = excluded.reset_at,
         window_started_at = excluded.window_started_at,
         observed_at       = excluded.observed_at`
    ).run(b.bucket_id, b.utilization, b.reset_at, b.window_started_at, b.observed_at);
  }

  replaceAll(buckets: BucketInput[]): void {
    this.db.transaction(() => {
      for (const b of buckets) this.upsert(b);
      const ids = buckets.map(b => b.bucket_id);
      if (ids.length === 0) {
        this.db.prepare('DELETE FROM rate_limit_buckets').run();
      } else {
        const placeholders = ids.map(() => '?').join(',');
        this.db
          .prepare(`DELETE FROM rate_limit_buckets WHERE bucket_id NOT IN (${placeholders})`)
          .run(...ids);
      }
    })();
  }

  markNotified(bucketId: string, threshold: number, resetAt: number | null): void {
    this.db.prepare(
      'UPDATE rate_limit_buckets SET last_notified_threshold = ?, last_notified_reset_at = ? WHERE bucket_id = ?'
    ).run(threshold, resetAt, bucketId);
  }

  clearNotifiedIfReset(): void {
    this.db.prepare(
      `UPDATE rate_limit_buckets
          SET last_notified_threshold = NULL,
              last_notified_reset_at = NULL
        WHERE last_notified_reset_at IS NOT NULL
          AND (reset_at IS NULL OR reset_at != last_notified_reset_at)`
    ).run();
  }
}
