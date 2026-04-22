import { describe, it, expect } from 'vitest';
import { parseResultJson } from './result.js';

describe('parseResultJson', () => {
  it('parses valid result', () => {
    expect(
      parseResultJson('{"exit_code":0,"push_exit":0,"head_sha":"abc"}\n')
    ).toEqual({ exit_code: 0, push_exit: 0, head_sha: 'abc' });
  });
  it('returns null for invalid JSON', () => {
    expect(parseResultJson('nope')).toBeNull();
  });
  it('returns null for missing fields', () => {
    expect(parseResultJson('{"exit_code":0}')).toBeNull();
  });
});
