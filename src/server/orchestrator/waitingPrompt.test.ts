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

  it('matches Claude Code 2.x "❯" prompt even with trailing TUI decoration', () => {
    // Real Claude Code 2.x frame (post-ANSI-strip): the "❯" prompt line is
    // followed by padding rows, a "─" separator, and a hint line — so the
    // prompt is NOT at end of buffer.
    const s = [
      '❯                                                                          ',
      '                                                                            ',
      '                                                                            ',
      '',
      '────────────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts',
      '  Tip: Connect Claude to your IDE · /ide',
    ].join('\n');
    expect(containsWaitingPrompt(s)).toBe(true);
  });

  it('matches a 2.x "❯" prompt with partially-typed user input', () => {
    // Once waiting is entered, jsonl growth (not the prompt regex) drives the
    // exit transition. While the user is typing but Claude hasn't re-engaged,
    // the prompt is still visible — match should still return true.
    const s = '\n❯ hello world\n\n─────\n  ? for shortcuts';
    expect(containsWaitingPrompt(s)).toBe(true);
  });

  it('does not match when the recent tail has no prompt marker', () => {
    const s = 'writing file… 3 > 2 is true\n────\n  Tip: something';
    expect(containsWaitingPrompt(s)).toBe(false);
  });
});
