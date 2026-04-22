import { describe, it, expect } from 'vitest';
import { composePrompt } from './composePrompt.js';

describe('composePrompt', () => {
  it('joins all four sections with --- separators', () => {
    const out = composePrompt({
      preamble: 'P', globalPrompt: 'G', instructions: 'I', runPrompt: 'R',
    });
    expect(out).toBe('P\n\n---\n\nG\n\n---\n\nI\n\n---\n\nR');
  });

  it('skips empty preamble/global/instructions; always keeps run prompt', () => {
    expect(composePrompt({ preamble: '', globalPrompt: '', instructions: '', runPrompt: 'R' })).toBe('R');
    expect(composePrompt({ preamble: 'P', globalPrompt: '', instructions: '', runPrompt: 'R' })).toBe('P\n\n---\n\nR');
    expect(composePrompt({ preamble: '', globalPrompt: 'G', instructions: 'I', runPrompt: 'R' })).toBe('G\n\n---\n\nI\n\n---\n\nR');
  });

  it('keeps whitespace-only sections (parity with supervisor.sh -s predicate)', () => {
    expect(composePrompt({ preamble: '  \n', globalPrompt: '', instructions: '', runPrompt: 'R' }))
      .toBe('  \n\n\n---\n\nR');
  });
});
