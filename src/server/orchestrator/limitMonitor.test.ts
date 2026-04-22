import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LimitMonitor } from './limitMonitor.js';

const LIMIT_MSG_STYLED =
  '\x1b[90m  ⎿  \x1b[0m\x1b[33mYou’ve hit your limit\x1b[0m ' +
  '\x1b[2m·\x1b[0m \x1b[33mresets 2pm (UTC)\x1b[0m\n';

describe('LimitMonitor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-limit-mon-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const touchSession = (bytes = 100) => {
    const p = path.join(tmpDir, 'session.jsonl');
    fs.appendFileSync(p, 'x'.repeat(bytes));
  };

  it('fires once when warmup + idle elapse with pattern in the tail', () => {
    let time = 0;
    let detected = 0;
    const mon = new LimitMonitor({
      mountDir: tmpDir,
      warmupMs: 60_000, idleMs: 15_000, checkMs: 3_000,
      onDetect: () => { detected++; },
      now: () => time,
    });
    touchSession(); // represents prior API activity
    mon.start();
    mon.feedLog(Buffer.from(LIMIT_MSG_STYLED));

    // Before warmup elapses, don't fire.
    time = 30_000;
    mon.checkNow();
    expect(detected).toBe(0);

    // Past warmup but mount dir was just touched → not yet idle.
    time = 70_000;
    touchSession();
    mon.checkNow();
    expect(detected).toBe(0);

    // Now idle for >15s AND past warmup → fire.
    time = 90_000;
    mon.checkNow();
    expect(detected).toBe(1);

    // Subsequent checks do not re-fire.
    time = 120_000;
    mon.checkNow();
    expect(detected).toBe(1);
    mon.stop();
  });

  it('does not fire if mount dir stays active (false-positive guard)', () => {
    // Simulates a user prompt that happens to contain the limit phrase: it
    // shows up in the TUI early, but Claude keeps making API calls, so the
    // mount dir is never idle.
    let time = 0;
    let detected = 0;
    const mon = new LimitMonitor({
      mountDir: tmpDir,
      warmupMs: 60_000, idleMs: 15_000, checkMs: 3_000,
      onDetect: () => { detected++; },
      now: () => time,
    });
    mon.start();
    mon.feedLog(Buffer.from(LIMIT_MSG_STYLED));

    // Simulate steady activity past warmup.
    for (let t = 10_000; t <= 120_000; t += 5_000) {
      time = t;
      touchSession(); // bump size
      mon.checkNow();
    }
    expect(detected).toBe(0);
    mon.stop();
  });

  it('does not fire before warmup even if idle+pattern are satisfied', () => {
    // Catches the cold-start edge case: account is already at its limit, the
    // very first API response carries the message, mount dir never grows.
    // We still hold the line until warmup elapses so any prompt echo has
    // scrolled out of the rolling buffer.
    let time = 0;
    let detected = 0;
    const mon = new LimitMonitor({
      mountDir: tmpDir,
      warmupMs: 60_000, idleMs: 15_000, checkMs: 3_000,
      onDetect: () => { detected++; },
      now: () => time,
    });
    mon.start();
    mon.feedLog(Buffer.from(LIMIT_MSG_STYLED));

    time = 40_000;  // idle and pattern present, but pre-warmup
    mon.checkNow();
    expect(detected).toBe(0);

    time = 75_000;  // now past warmup, still idle, still pattern
    mon.checkNow();
    expect(detected).toBe(1);
    mon.stop();
  });

  it('ignores the lenient pattern alone (no false positives on "usage limit")', () => {
    let time = 0;
    let detected = 0;
    const mon = new LimitMonitor({
      mountDir: tmpDir,
      warmupMs: 60_000, idleMs: 15_000, checkMs: 3_000,
      onDetect: () => { detected++; },
      now: () => time,
    });
    mon.start();
    mon.feedLog(Buffer.from('some talk about a usage limit in the abstract\n'));

    time = 120_000;
    mon.checkNow();
    expect(detected).toBe(0);
    mon.stop();
  });
});
