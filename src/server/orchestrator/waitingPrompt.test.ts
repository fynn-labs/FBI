import { describe, it, expect } from 'vitest';
import { containsWaitingPrompt } from './waitingPrompt.js';

describe('containsWaitingPrompt', () => {
  it('matches a bordered TUI prompt at tail', () => {
    const s = 'some earlier output\n│ > ';
    expect(containsWaitingPrompt(s)).toBe(true);
  });

  it('matches a plain "> " prompt line at tail', () => {
    const s = 'some earlier output\n> ';
    expect(containsWaitingPrompt(s)).toBe(true);
  });

  it('does not match when the line has text after the prompt', () => {
    const s = 'some earlier output\n> typed this much';
    expect(containsWaitingPrompt(s)).toBe(false);
  });

  it('does not match a mid-turn transcript line that contains ">"', () => {
    const s = 'I found that 3 > 2 is true, proceeding with the plan\n';
    expect(containsWaitingPrompt(s)).toBe(false);
  });

  it('tolerates trailing whitespace / newlines after the prompt', () => {
    const s = 'some earlier output\n│ > \n\n   ';
    expect(containsWaitingPrompt(s)).toBe(true);
  });
});
