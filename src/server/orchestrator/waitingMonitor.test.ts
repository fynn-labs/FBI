import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WaitingMonitor } from './waitingMonitor.js';

const PROMPT_BYTES = Buffer.from('\x1b[2m│\x1b[0m \x1b[1m> \x1b[0m');

describe('WaitingMonitor', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-wait-mon-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const touch = (bytes = 100) => {
    fs.appendFileSync(path.join(dir, 'session.jsonl'), 'x'.repeat(bytes));
  };

  it('does not fire before warmup, even when idle + prompt match', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);
    time = 10_000;
    mon.checkNow();
    expect(entered).toBe(0);
    mon.stop();
  });

  it('fires onEnter once both signals hold past warmup', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);
    time = 30_000;                // past warmup AND past idleMs of silence
    mon.checkNow();
    expect(entered).toBe(1);
    mon.checkNow();               // stays entered; no duplicate onEnter
    expect(entered).toBe(1);
    mon.stop();
  });

  it('does not fire when the TTY tail has no prompt', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(Buffer.from('reading file foo.ts...\n'));
    time = 30_000;
    mon.checkNow();
    expect(entered).toBe(0);
    mon.stop();
  });

  it('does not fire when mount-dir is still active', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);
    time = 25_000;
    touch();                      // fresh write: mount dir still active
    mon.checkNow();
    expect(entered).toBe(0);
    mon.stop();
  });

  it('fires onExit on the first jsonl write after entering', () => {
    let time = 0;
    let entered = 0, exited = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => { exited++; },
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);
    time = 30_000;
    mon.checkNow();
    expect(entered).toBe(1);

    time = 32_000;
    touch();                      // user typed; Claude is working again
    mon.checkNow();
    expect(exited).toBe(1);
    mon.stop();
  });

  it('toggles multiple times across a single lifetime', () => {
    let time = 0;
    let entered = 0, exited = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => { exited++; },
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);

    time = 30_000; mon.checkNow();
    expect(entered).toBe(1);

    time = 32_000; touch(); mon.checkNow();
    expect(exited).toBe(1);

    // Second idle period — requires idleMs of silence again.
    time = 45_000; mon.feedLog(PROMPT_BYTES); mon.checkNow();
    expect(entered).toBe(2);

    mon.stop();
  });

  it('feedLog tolerates ANSI escapes in the prompt frame', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(Buffer.from('\x1b[K\x1b[2J\x1b[H\x1b[2m│\x1b[0m \x1b[1m> \x1b[0m'));
    time = 30_000; mon.checkNow();
    expect(entered).toBe(1);
    mon.stop();
  });
});
