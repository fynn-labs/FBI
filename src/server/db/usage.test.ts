import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, type DB } from './index.js';
import { ProjectsRepo } from './projects.js';
import { RunsRepo } from './runs.js';
import { UsageRepo } from './usage.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-usage-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const usage = new UsageRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const run = runs.create({
    project_id: p.id, prompt: 'hi',
    log_path_tmpl: (id) => `/tmp/${id}.log`,
  });
  return { db, projects, runs, usage, runId: run.id };
}

describe('UsageRepo.insertUsageEvent', () => {
  it('inserts a row and updates run totals atomically', () => {
    const { runs, usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId,
      ts: 1000,
      snapshot: {
        model: 'claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 200,
        cache_create_tokens: 10,
      },
      rate_limit: null,
    });
    const after = runs.get(runId)!;
    expect(after.tokens_input).toBe(100);
    expect(after.tokens_output).toBe(50);
    expect(after.tokens_cache_read).toBe(200);
    expect(after.tokens_cache_create).toBe(10);
    expect(after.tokens_total).toBe(360);
    expect(after.usage_parse_errors).toBe(0);
  });

  it('accumulates across multiple events', () => {
    const { runs, usage, runId } = setup();
    for (let i = 0; i < 3; i++) {
      usage.insertUsageEvent({
        run_id: runId, ts: 1000 + i,
        snapshot: {
          model: 'claude-sonnet-4-6',
          input_tokens: 10, output_tokens: 5,
          cache_read_tokens: 0, cache_create_tokens: 0,
        },
        rate_limit: null,
      });
    }
    expect(runs.get(runId)!.tokens_total).toBe(3 * 15);
  });

  it('bumpParseErrors increments usage_parse_errors', () => {
    const { runs, usage, runId } = setup();
    usage.bumpParseErrors(runId);
    usage.bumpParseErrors(runId);
    expect(runs.get(runId)!.usage_parse_errors).toBe(2);
  });

  it('ON DELETE CASCADE removes events when run is deleted', () => {
    const { db, runs, usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId, ts: 1000,
      snapshot: {
        model: 'claude-sonnet-4-6',
        input_tokens: 1, output_tokens: 1,
        cache_read_tokens: 0, cache_create_tokens: 0,
      },
      rate_limit: null,
    });
    runs.delete(runId);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM run_usage_events').get() as { n: number }).n;
    expect(n).toBe(0);
  });
});

describe('UsageRepo rate-limit singleton', () => {
  it('getRateLimitState returns fully-null shape when nothing observed', () => {
    const { usage } = setup();
    const s = usage.getRateLimitState(Date.now());
    expect(s.observed_at).toBeNull();
    expect(s.percent_used).toBeNull();
    expect(s.reset_in_seconds).toBeNull();
    expect(s.observed_seconds_ago).toBeNull();
  });

  it('upsertRateLimitState writes a row and the derived fields compute correctly', () => {
    const { usage, runId } = setup();
    const now = 10_000_000;
    usage.upsertRateLimitState({
      observed_at: now,
      observed_from_run_id: runId,
      snapshot: {
        requests_remaining: 50, requests_limit: 200,
        tokens_remaining: null, tokens_limit: null,
        reset_at: now + 3600_000,
      },
    });
    const s = usage.getRateLimitState(now + 1000);
    expect(s.requests_remaining).toBe(50);
    expect(s.percent_used).toBeCloseTo((200 - 50) / 200);
    expect(s.reset_in_seconds).toBe(3599);
    expect(s.observed_seconds_ago).toBe(1);
  });

  it('falls back to tokens_remaining/limit when requests fields are missing', () => {
    const { usage, runId } = setup();
    const now = 20_000_000;
    usage.upsertRateLimitState({
      observed_at: now, observed_from_run_id: runId,
      snapshot: {
        requests_remaining: null, requests_limit: null,
        tokens_remaining: 250_000, tokens_limit: 1_000_000,
        reset_at: null,
      },
    });
    const s = usage.getRateLimitState(now);
    expect(s.percent_used).toBeCloseTo(0.75);
    expect(s.reset_in_seconds).toBeNull();
  });

  it('drops an older snapshot (last-write-wins by observed_at)', () => {
    const { usage, runId } = setup();
    usage.upsertRateLimitState({
      observed_at: 2000, observed_from_run_id: runId,
      snapshot: {
        requests_remaining: 10, requests_limit: 100,
        tokens_remaining: null, tokens_limit: null, reset_at: null,
      },
    });
    usage.upsertRateLimitState({
      observed_at: 1000, observed_from_run_id: runId,
      snapshot: {
        requests_remaining: 99, requests_limit: 100,
        tokens_remaining: null, tokens_limit: null, reset_at: null,
      },
    });
    expect(usage.getRateLimitState(3000).requests_remaining).toBe(10);
  });
});
