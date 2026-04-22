import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { RateLimitStateRepo } from './rateLimitState.js';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  return new RateLimitStateRepo(db);
}

describe('RateLimitStateRepo', () => {
  it('returns null when nothing observed', () => {
    const repo = makeRepo();
    expect(repo.get()).toBeNull();
  });

  it('upsert + get round-trip', () => {
    const repo = makeRepo();
    repo.upsert({
      requests_remaining: 0,
      requests_limit: 100,
      tokens_remaining: 5000,
      tokens_limit: 200000,
      reset_at: 9000,
      observed_at: 8000,
      observed_from_run_id: 42,
    });
    const s = repo.get();
    expect(s).not.toBeNull();
    expect(s!.requests_remaining).toBe(0);
    expect(s!.reset_at).toBe(9000);
  });

  it('upsert is last-write-wins when observed_at advances', () => {
    const repo = makeRepo();
    repo.upsert({
      requests_remaining: 10, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: 1000, observed_at: 1000, observed_from_run_id: 1,
    });
    repo.upsert({
      requests_remaining: 0, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: 2000, observed_at: 2000, observed_from_run_id: 2,
    });
    expect(repo.get()!.requests_remaining).toBe(0);
  });

  it('upsert ignores older observations', () => {
    const repo = makeRepo();
    repo.upsert({
      requests_remaining: 0, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: 2000, observed_at: 2000, observed_from_run_id: 2,
    });
    repo.upsert({
      requests_remaining: 50, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: 1000, observed_at: 1000, observed_from_run_id: 1,
    });
    expect(repo.get()!.requests_remaining).toBe(0);
  });
});
