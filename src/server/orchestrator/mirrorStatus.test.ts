import { describe, it, expect } from 'vitest';
import { parseMirrorStatus } from './mirrorStatus.js';

describe('parseMirrorStatus', () => {
  it('returns ok for literal "ok"', () => {
    expect(parseMirrorStatus('ok\n')).toBe('ok');
  });
  it('returns diverged for literal "diverged"', () => {
    expect(parseMirrorStatus('diverged\n')).toBe('diverged');
  });
  it('parses local_only', () => {
    expect(parseMirrorStatus('local_only')).toBe('local_only');
  });
  it('returns null for anything else', () => {
    expect(parseMirrorStatus('')).toBeNull();
    expect(parseMirrorStatus('garbage')).toBeNull();
  });
});
