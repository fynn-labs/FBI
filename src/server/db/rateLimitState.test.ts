import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from './index.js';
import { RateLimitStateRepo } from './rateLimitState.js';

describe('RateLimitStateRepo', () => {
  let db: DB;
  let repo: RateLimitStateRepo;
  beforeEach(() => { db = openDb(':memory:'); repo = new RateLimitStateRepo(db); });

  it('get() returns default state on fresh DB', () => {
    expect(repo.get()).toEqual({
      plan: null, observed_at: null, last_error: null, last_error_at: null,
    });
  });

  it('setObserved stamps observed_at and clears last_error', () => {
    repo.setError('network', 1000);
    repo.setObserved(2000);
    expect(repo.get()).toEqual({
      plan: null, observed_at: 2000, last_error: null, last_error_at: null,
    });
  });

  it('setError stamps last_error and last_error_at but not observed_at', () => {
    repo.setError('rate_limited', 500);
    expect(repo.get()).toEqual({
      plan: null, observed_at: null,
      last_error: 'rate_limited', last_error_at: 500,
    });
  });

  it('setPlan stores plan value', () => {
    repo.setPlan('max');
    expect(repo.get().plan).toBe('max');
  });
});
