import { describe, it, expect } from 'vitest';
import { classifyResultJson } from './result.js';

describe('classifyResultJson', () => {
  it('returns resume_failed when stage=="restore" and error is set', () => {
    const r = classifyResultJson(JSON.stringify({
      stage: 'restore', error: 'diverged', parent_sha: 'a', snapshot_sha: 'b', origin_tip: 'c',
    }));
    expect(r.kind).toBe('resume_failed');
    if (r.kind === 'resume_failed') expect(r.error).toBe('diverged');
  });
  it('returns completed for normal finalize', () => {
    const r = classifyResultJson(JSON.stringify({
      exit_code: 0, push_exit: 0, head_sha: 'h', branch: 'claude/run-1', wip_sha: '',
    }));
    expect(r.kind).toBe('completed');
  });
  it('returns unparseable for empty string', () => {
    expect(classifyResultJson('').kind).toBe('unparseable');
  });
  it('returns unparseable for garbage', () => {
    expect(classifyResultJson('{not json').kind).toBe('unparseable');
  });
});
