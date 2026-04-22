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
