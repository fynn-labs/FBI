import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { classify } from './resumeDetector.js';

// Fixed "now" anchored before the pipe-epoch fixture's reset time (1776870000 * 1000).
// Using April 22, 2026 00:00:00 UTC so the fixture epoch (15:00 UTC same day) is
// reliably in the future regardless of when this test actually runs.
const FIXED_NOW = 1776816000000; // 2026-04-22T00:00:00Z

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-resume-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  return { runs, projectId: p.id };
}

describe('auto-resume: classify + DB transitions', () => {
  it('rate-limit log triggers awaiting_resume transition', () => {
    const { runs, projectId } = setup();
    const r = runs.create({ project_id: projectId, prompt: 'fix it',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.markStarted(r.id, 'c1');

    const logTail = '[fbi] resolving image\n... normal output ...\nClaude usage limit reached|1776870000';
    const verdict = classify(logTail, null, FIXED_NOW);

    expect(verdict.kind).toBe('rate_limit');
    expect(verdict.reset_at).not.toBeNull();

    const run = runs.get(r.id)!;
    const maxAttempts = 5;
    if (verdict.kind === 'rate_limit' && verdict.reset_at !== null) {
      if (run.resume_attempts + 1 <= maxAttempts) {
        runs.markAwaitingResume(r.id, {
          next_resume_at: verdict.reset_at,
          last_limit_reset_at: verdict.reset_at,
        });
      } else {
        runs.markFinished(r.id, { state: 'failed', error: 'cap exceeded' });
      }
    }

    const updated = runs.get(r.id)!;
    expect(updated.state).toBe('awaiting_resume');
    expect(updated.next_resume_at).toBe(verdict.reset_at);
    expect(updated.resume_attempts).toBe(1);
  });

  it('cap exceeded: marks run failed instead of awaiting_resume', () => {
    const { runs, projectId } = setup();
    const r = runs.create({ project_id: projectId, prompt: 'fix it',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.markStarted(r.id, 'c1');

    // Exhaust the cap: cycle through markAwaitingResume + markResuming N times
    const maxAttempts = 3;
    for (let i = 0; i < maxAttempts; i++) {
      runs.markAwaitingResume(r.id, {
        next_resume_at: FIXED_NOW + 60_000,
        last_limit_reset_at: FIXED_NOW + 60_000,
      });
      runs.markResuming(r.id, `c${i + 2}`);
    }

    const run = runs.get(r.id)!;
    expect(run.resume_attempts).toBe(maxAttempts);
    expect(run.state).toBe('running');

    const logTail = 'Claude usage limit reached|1776870000';
    const verdict = classify(logTail, null, FIXED_NOW);

    expect(verdict.kind).toBe('rate_limit');
    expect(verdict.reset_at).not.toBeNull();

    if (verdict.kind === 'rate_limit' && verdict.reset_at !== null) {
      if (run.resume_attempts + 1 > maxAttempts) {
        runs.markFinished(r.id, {
          state: 'failed',
          error: `rate limited; exceeded auto-resume cap (${maxAttempts} attempts)`,
        });
      } else {
        runs.markAwaitingResume(r.id, {
          next_resume_at: verdict.reset_at,
          last_limit_reset_at: verdict.reset_at,
        });
      }
    }

    const final = runs.get(r.id)!;
    expect(final.state).toBe('failed');
    expect(final.error).toContain('exceeded auto-resume cap');
  });
});
