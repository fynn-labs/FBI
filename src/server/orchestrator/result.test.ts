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
  it('parses optional branch field', () => {
    const r = parseResultJson(
      '{"exit_code":0,"push_exit":0,"head_sha":"abc","branch":"fix-login"}'
    );
    expect(r?.branch).toBe('fix-login');
  });
  it('accepts absence of branch field', () => {
    const r = parseResultJson(
      '{"exit_code":0,"push_exit":0,"head_sha":"abc"}'
    );
    expect(r).not.toBeNull();
    expect(r?.branch).toBeUndefined();
  });
  it('extracts a title when present', () => {
    const r = parseResultJson(JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'abc', title: 'Fix auth race' }));
    expect(r?.title).toBe('Fix auth race');
  });
  it('trims and truncates title to 80 chars', () => {
    const r = parseResultJson(JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'abc', title: '   ' + 'x'.repeat(200) + '   ' }));
    expect(r?.title).toHaveLength(80);
  });
  it('omits title when empty or whitespace', () => {
    const r = parseResultJson(JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'abc', title: '  ' }));
    expect(r?.title).toBeUndefined();
  });
  it('parses successfully when title is absent', () => {
    const r = parseResultJson(JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'abc' }));
    expect(r).not.toBeNull();
    expect(r?.title).toBeUndefined();
  });
});
