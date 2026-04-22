import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from './index.js';
import { RateLimitBucketsRepo } from './rateLimitBuckets.js';

describe('RateLimitBucketsRepo', () => {
  let db: DB;
  let repo: RateLimitBucketsRepo;
  beforeEach(() => { db = openDb(':memory:'); repo = new RateLimitBucketsRepo(db); });

  it('list() is empty on a fresh DB', () => {
    expect(repo.list()).toEqual([]);
  });

  it('upsert inserts and replaces by bucket_id', () => {
    repo.upsert({ bucket_id: 'five_hour', utilization: 0.4, reset_at: 1000, window_started_at: 500, observed_at: 800 });
    repo.upsert({ bucket_id: 'five_hour', utilization: 0.5, reset_at: 1100, window_started_at: 500, observed_at: 900 });
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].utilization).toBe(0.5);
  });

  it('replaceAll writes new set and deletes missing buckets', () => {
    repo.upsert({ bucket_id: 'five_hour', utilization: 0.1, reset_at: 1, window_started_at: 0, observed_at: 1 });
    repo.upsert({ bucket_id: 'weekly',    utilization: 0.2, reset_at: 2, window_started_at: 0, observed_at: 1 });
    repo.replaceAll([
      { bucket_id: 'five_hour', utilization: 0.9, reset_at: 3, window_started_at: 0, observed_at: 2 },
    ]);
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket_id).toBe('five_hour');
    expect(rows[0].utilization).toBe(0.9);
  });

  it('replaceAll with empty array deletes all buckets', () => {
    repo.upsert({ bucket_id: 'five_hour', utilization: 0.1, reset_at: 1, window_started_at: 0, observed_at: 1 });
    repo.replaceAll([]);
    expect(repo.list()).toEqual([]);
  });

  it('markNotified sets threshold and reset_at', () => {
    repo.upsert({ bucket_id: 'five_hour', utilization: 0.95, reset_at: 9000, window_started_at: 0, observed_at: 1 });
    repo.markNotified('five_hour', 90, 9000);
    const row = repo.list()[0];
    expect(row.last_notified_threshold).toBe(90);
    expect(row.last_notified_reset_at).toBe(9000);
  });

  it('clearNotifiedIfReset resets bookkeeping when reset_at changed', () => {
    repo.upsert({ bucket_id: 'five_hour', utilization: 0.95, reset_at: 9000, window_started_at: 0, observed_at: 1 });
    repo.markNotified('five_hour', 90, 9000);
    // Simulate a new window (reset_at changed).
    repo.upsert({ bucket_id: 'five_hour', utilization: 0.10, reset_at: 18000, window_started_at: 9000, observed_at: 2 });
    repo.clearNotifiedIfReset();
    expect(repo.list()[0].last_notified_threshold).toBeNull();
  });
});
