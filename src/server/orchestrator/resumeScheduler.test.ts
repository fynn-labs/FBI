import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { ResumeScheduler } from './resumeScheduler.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const fired: number[] = [];
  const scheduler = new ResumeScheduler({
    runs,
    onFire: async (id) => { fired.push(id); },
  });
  return { runs, projectId: p.id, scheduler, fired };
}

describe('ResumeScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedule fires at the target time', async () => {
    const { scheduler, fired } = setup();
    scheduler.schedule(1, Date.now() + 1000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(fired).toEqual([1]);
  });

  it('fireAt in the past fires immediately', async () => {
    const { scheduler, fired } = setup();
    scheduler.schedule(2, Date.now() - 5000);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual([2]);
  });

  it('cancel prevents fire', async () => {
    const { scheduler, fired } = setup();
    scheduler.schedule(3, Date.now() + 500);
    scheduler.cancel(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toEqual([]);
  });

  it('fireNow fires on next tick and clears the timer', async () => {
    const { scheduler, fired } = setup();
    scheduler.schedule(4, Date.now() + 5000);
    scheduler.fireNow(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual([4]);
    // Advancing past original target must not re-fire.
    await vi.advanceTimersByTimeAsync(6000);
    expect(fired).toEqual([4]);
  });

  it('rehydrate schedules all awaiting rows', async () => {
    const { runs, projectId, scheduler, fired } = setup();
    for (const at of [1000, 2000]) {
      const r = runs.create({
        project_id: projectId, prompt: 'x',
        log_path_tmpl: (id) => `/tmp/${id}.log`,
      });
      runs.markStarted(r.id, 'c');
      runs.markAwaitingResume(r.id, { next_resume_at: Date.now() + at, last_limit_reset_at: Date.now() + at });
    }
    await scheduler.rehydrate();
    await vi.advanceTimersByTimeAsync(2500);
    expect(fired.length).toBe(2);
  });

  it('rehydrate fires on next tick when next_resume_at is 0 (epoch past)', async () => {
    const { runs, projectId, scheduler, fired } = setup();
    const r = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(r.id, 'c');
    runs.markAwaitingResume(r.id, { next_resume_at: 0, last_limit_reset_at: 0 });
    await scheduler.rehydrate();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toContain(r.id);
  });
});
