import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nudgeClaudeToExit } from './nudgeClaude.js';

describe('nudgeClaudeToExit', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends a Ctrl-C byte immediately and a second one shortly after (Claude Code TUI needs a double-tap to exit)', () => {
    const writes: number[] = [];
    nudgeClaudeToExit({
      writeStdin: (b) => writes.push(b[0]),
      killContainer: async () => {},
      log: () => {},
      secondCtrlCDelayMs: 250,
      killAfterMs: 30_000,
    });

    // First Ctrl-C is synchronous.
    expect(writes).toEqual([0x03]);

    // Second one fires after the configured delay.
    vi.advanceTimersByTime(249);
    expect(writes).toEqual([0x03]);
    vi.advanceTimersByTime(2);
    expect(writes).toEqual([0x03, 0x03]);
  });

  it('schedules container kill as last-resort fallback after killAfterMs', async () => {
    const killed = vi.fn().mockResolvedValue(undefined);
    nudgeClaudeToExit({
      writeStdin: () => {},
      killContainer: killed,
      log: () => {},
      secondCtrlCDelayMs: 250,
      killAfterMs: 30_000,
    });

    expect(killed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29_999);
    expect(killed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(killed).toHaveBeenCalledTimes(1);
  });

  it('surfaces a human-readable message via the log callback', () => {
    const messages: string[] = [];
    nudgeClaudeToExit({
      writeStdin: () => {},
      killContainer: async () => {},
      log: (m) => messages.push(m),
      secondCtrlCDelayMs: 250,
      killAfterMs: 30_000,
    });
    expect(messages.join('\n')).toMatch(/rate-limit/);
    expect(messages.join('\n')).toMatch(/claude/i);
  });

  it('swallows writeStdin errors (stream may already be closed)', () => {
    expect(() => {
      nudgeClaudeToExit({
        writeStdin: () => { throw new Error('already closed'); },
        killContainer: async () => {},
        log: () => {},
        secondCtrlCDelayMs: 250,
        killAfterMs: 30_000,
      });
      // Second attempt on the timer should also be absorbed.
      vi.advanceTimersByTime(300);
    }).not.toThrow();
  });

  it('swallows killContainer rejections (container may already be gone)', () => {
    nudgeClaudeToExit({
      writeStdin: () => {},
      killContainer: async () => { throw new Error('already stopped'); },
      log: () => {},
      secondCtrlCDelayMs: 250,
      killAfterMs: 30_000,
    });
    expect(() => vi.advanceTimersByTime(30_001)).not.toThrow();
  });
});
