import { describe, it, expect } from 'vitest';
import { generateDraftToken, isDraftToken } from './token.js';

describe('generateDraftToken', () => {
  it('returns 32-char lowercase hex', () => {
    const t = generateDraftToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces different tokens on successive calls', () => {
    const a = generateDraftToken();
    const b = generateDraftToken();
    expect(a).not.toBe(b);
  });
});

describe('isDraftToken', () => {
  it('accepts a generated token', () => {
    expect(isDraftToken(generateDraftToken())).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isDraftToken('')).toBe(false);
    expect(isDraftToken('abc')).toBe(false);
    expect(isDraftToken('g'.repeat(32))).toBe(false);            // not hex
    expect(isDraftToken('A'.repeat(32))).toBe(false);            // uppercase
    expect(isDraftToken('/' + '0'.repeat(31))).toBe(false);
    expect(isDraftToken('..')).toBe(false);
  });
});
