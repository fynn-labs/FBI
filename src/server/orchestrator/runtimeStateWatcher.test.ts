import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeStateWatcher, type DerivedRuntimeState } from './runtimeStateWatcher.js';

describe('RuntimeStateWatcher', () => {
  let dir: string;
  let waiting: string;
  let prompted: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-rsw-'));
    waiting = path.join(dir, 'waiting');
    prompted = path.join(dir, 'prompted');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const mk = () => {
    const events: DerivedRuntimeState[] = [];
    const w = new RuntimeStateWatcher({
      waitingPath: waiting,
      promptedPath: prompted,
      onChange: (s) => events.push(s),
    });
    return { w, events };
  };

  it('emits starting on first poll when both files are absent', () => {
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['starting']);
  });

  it('emits running on first poll when only prompted is present (reattach mid-turn)', () => {
    fs.writeFileSync(prompted, '');
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['running']);
  });

  it('emits waiting on first poll when waiting is present (reattach at idle)', () => {
    fs.writeFileSync(waiting, '');
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['waiting']);
  });

  it('waiting wins when both files are present', () => {
    fs.writeFileSync(waiting, '');
    fs.writeFileSync(prompted, '');
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['waiting']);
  });

  it('starting -> running when prompted appears', () => {
    const { w, events } = mk();
    w.checkNow();
    fs.writeFileSync(prompted, '');
    w.checkNow();
    expect(events).toEqual(['starting', 'running']);
  });

  it('starting -> waiting directly when Stop fires before any prompt (continue case)', () => {
    const { w, events } = mk();
    w.checkNow();
    fs.writeFileSync(waiting, '');
    w.checkNow();
    expect(events).toEqual(['starting', 'waiting']);
  });

  it('running -> waiting -> running over a turn', () => {
    fs.writeFileSync(prompted, '');
    const { w, events } = mk();
    w.checkNow();                       // running
    fs.writeFileSync(waiting, '');
    w.checkNow();                       // waiting
    fs.unlinkSync(waiting);
    w.checkNow();                       // running (prompted still present)
    expect(events).toEqual(['running', 'waiting', 'running']);
  });

  it('does not re-emit on identical successive polls', () => {
    fs.writeFileSync(prompted, '');
    const { w, events } = mk();
    w.checkNow();
    w.checkNow();
    w.checkNow();
    expect(events).toEqual(['running']);
  });

  it('start()/stop() drives polling', async () => {
    const events: DerivedRuntimeState[] = [];
    const w = new RuntimeStateWatcher({
      waitingPath: waiting, promptedPath: prompted, pollMs: 10,
      onChange: (s) => events.push(s),
    });
    w.start();
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(prompted, '');
    await new Promise((r) => setTimeout(r, 50));
    w.stop();
    expect(events).toEqual(['starting', 'running']);
  });

  it('stop() is idempotent and silent after', async () => {
    const events: DerivedRuntimeState[] = [];
    const w = new RuntimeStateWatcher({
      waitingPath: waiting, promptedPath: prompted, pollMs: 10,
      onChange: (s) => events.push(s),
    });
    w.start();
    w.stop();
    w.stop();
    fs.writeFileSync(prompted, '');
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(['starting']);  // first poll happened before stop
  });
});
