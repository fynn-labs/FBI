import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WaitingWatcher } from './waitingWatcher.js';

describe('WaitingWatcher', () => {
  let dir: string;
  let sentinel: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-wait-watch-'));
    sentinel = path.join(dir, 'waiting');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const mk = () => {
    const events: Array<'enter' | 'exit'> = [];
    const w = new WaitingWatcher({
      path: sentinel,
      onEnter: () => events.push('enter'),
      onExit: () => events.push('exit'),
    });
    return { w, events };
  };

  it('stays silent on first poll when sentinel is absent', () => {
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual([]);
  });

  it('fires onEnter when sentinel first appears', () => {
    const { w, events } = mk();
    w.checkNow();
    fs.writeFileSync(sentinel, '');
    w.checkNow();
    expect(events).toEqual(['enter']);
  });

  it('fires onExit when sentinel disappears after being present', () => {
    const { w, events } = mk();
    fs.writeFileSync(sentinel, '');
    w.checkNow();
    fs.unlinkSync(sentinel);
    w.checkNow();
    expect(events).toEqual(['enter', 'exit']);
  });

  it('does not fire on repeated polls with no transition', () => {
    const { w, events } = mk();
    fs.writeFileSync(sentinel, '');
    w.checkNow();
    w.checkNow();
    w.checkNow();
    expect(events).toEqual(['enter']);
  });

  it('toggles multiple times across a lifetime', () => {
    const { w, events } = mk();
    fs.writeFileSync(sentinel, ''); w.checkNow();
    fs.unlinkSync(sentinel);        w.checkNow();
    fs.writeFileSync(sentinel, ''); w.checkNow();
    fs.unlinkSync(sentinel);        w.checkNow();
    expect(events).toEqual(['enter', 'exit', 'enter', 'exit']);
  });

  it('fires onEnter on first poll if sentinel already exists (reattach case)', () => {
    fs.writeFileSync(sentinel, '');
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['enter']);
  });

  it('start()/stop() drives polling', async () => {
    const events: Array<'enter' | 'exit'> = [];
    const w = new WaitingWatcher({
      path: sentinel,
      pollMs: 10,
      onEnter: () => events.push('enter'),
      onExit: () => events.push('exit'),
    });
    w.start();
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(sentinel, '');
    await new Promise((r) => setTimeout(r, 50));
    w.stop();
    expect(events).toEqual(['enter']);
  });

  it('stop() is idempotent and silent after', async () => {
    const events: Array<'enter' | 'exit'> = [];
    const w = new WaitingWatcher({
      path: sentinel,
      pollMs: 10,
      onEnter: () => events.push('enter'),
      onExit: () => events.push('exit'),
    });
    w.start();
    w.stop();
    w.stop();
    fs.writeFileSync(sentinel, '');
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);
  });
});
