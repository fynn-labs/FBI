import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkContinueEligibility } from './continueEligibility.js';
import type { Run } from '../../shared/types.js';

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 42,
    project_id: 1,
    prompt: 'hi',
    branch_name: 'feat/x',
    state: 'failed',
    container_id: null,
    log_path: '/tmp/42.log',
    exit_code: 1,
    error: 'boom',
    head_commit: null,
    started_at: 1,
    finished_at: 2,
    created_at: 0,
    claude_session_id: 'sess-abc',
    resume_attempts: 0,
    next_resume_at: null,
    last_limit_reset_at: null,
    ...overrides,
  } as Run;
}

describe('checkContinueEligibility', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-elig-'));
  });
  afterEach(() => {
    try { fs.rmSync(runsDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const writeSession = (runId: number) => {
    const dir = path.join(runsDir, String(runId), 'claude-projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-abc.jsonl'), '{"x":1}\n');
  };

  it('accepts a failed run with session id and session files on disk', () => {
    writeSession(42);
    expect(checkContinueEligibility(baseRun(), runsDir)).toEqual({ ok: true });
  });

  it('accepts a cancelled run', () => {
    writeSession(42);
    expect(
      checkContinueEligibility(baseRun({ state: 'cancelled' }), runsDir),
    ).toEqual({ ok: true });
  });

  it('rejects a running run with wrong_state', () => {
    writeSession(42);
    const r = checkContinueEligibility(baseRun({ state: 'running' }), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('wrong_state');
  });

  it('accepts a succeeded run (continuation is allowed after success)', () => {
    writeSession(42);
    expect(
      checkContinueEligibility(baseRun({ state: 'succeeded' }), runsDir),
    ).toEqual({ ok: true });
  });

  it('rejects a queued run with wrong_state', () => {
    writeSession(42);
    const r = checkContinueEligibility(baseRun({ state: 'queued' }), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('wrong_state');
  });

  it('rejects runs already in starting state (double-click guard)', () => {
    writeSession(42);
    const r = checkContinueEligibility(baseRun({ state: 'starting' }), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('wrong_state');
  });

  it('rejects when claude_session_id is null', () => {
    const r = checkContinueEligibility(
      baseRun({ claude_session_id: null }), runsDir,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_session');
  });

  it('rejects when session dir does not exist', () => {
    const r = checkContinueEligibility(baseRun(), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('session_files_missing');
  });

  it('rejects when session dir exists but contains no jsonl files', () => {
    const dir = path.join(runsDir, '42', 'claude-projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'other.txt'), 'nope');
    const r = checkContinueEligibility(baseRun(), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('session_files_missing');
  });
});
