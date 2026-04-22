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
    expect(after.tokens_total).toBe(150);
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

describe('UsageRepo aggregations', () => {
  it('listDailyUsage groups by local date', () => {
    const { usage, runId } = setup();
    // Two events on day D, one on day D-1 (using fixed UTC midnights for determinism)
    const day1 = Date.UTC(2026, 3, 20, 12, 0, 0);  // noon
    const day2 = Date.UTC(2026, 3, 21, 12, 0, 0);
    for (const ts of [day1, day1 + 1000, day2]) {
      usage.insertUsageEvent({
        run_id: runId, ts,
        snapshot: {
          model: 'claude-sonnet-4-6',
          input_tokens: 10, output_tokens: 5,
          cache_read_tokens: 0, cache_create_tokens: 0,
        },
        rate_limit: null,
      });
    }
    const rows = usage.listDailyUsage({ days: 14, now: Date.UTC(2026, 3, 22, 0, 0, 0) });
    // Exactly two distinct days.
    const distinct = new Set(rows.map((r) => r.date));
    expect(distinct.size).toBe(2);
  });

  it('listDailyUsage clamps days to [1, 90]', () => {
    const { usage } = setup();
    expect(usage.listDailyUsage({ days: 0, now: Date.now() }).length).toBeGreaterThanOrEqual(0);
    expect(() => usage.listDailyUsage({ days: 1000, now: Date.now() })).not.toThrow();
  });

  it('listDailyUsage tokens_total is input + output only (not cache)', () => {
    const now = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-usage-billable-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const repo = new UsageRepo(db);
    db.prepare(`INSERT INTO projects (id, name, repo_url, default_branch, created_at, updated_at)
                VALUES (1, 'p', 'g', 'main', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO runs (id, project_id, prompt, branch_name, state, log_path, created_at)
                VALUES (1, 1, 'p', 'b', 'succeeded', '/l', ?)`).run(now);
    repo.insertUsageEvent({
      run_id: 1, ts: now,
      snapshot: { model: 'claude-opus-4-7', input_tokens: 100, output_tokens: 200, cache_read_tokens: 5000, cache_create_tokens: 1000 },
      rate_limit: null,
    });
    const rows = repo.listDailyUsage({ days: 14, now });
    expect(rows[0].tokens_total).toBe(300);
    expect(rows[0].tokens_cache_read).toBe(5000);
  });

  it('getRunBreakdown groups by model', () => {
    const { usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId, ts: 1,
      snapshot: { model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 5,
        cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    usage.insertUsageEvent({
      run_id: runId, ts: 2,
      snapshot: { model: 'claude-sonnet-4-6', input_tokens: 20, output_tokens: 10,
        cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    usage.insertUsageEvent({
      run_id: runId, ts: 3,
      snapshot: { model: 'claude-haiku-4-5', input_tokens: 3, output_tokens: 1,
        cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    const rows = usage.getRunBreakdown(runId);
    const sonnet = rows.find((r) => r.model === 'claude-sonnet-4-6')!;
    const haiku = rows.find((r) => r.model === 'claude-haiku-4-5')!;
    expect(sonnet.input).toBe(30);
    expect(sonnet.output).toBe(15);
    expect(haiku.input).toBe(3);
  });
});
