import { describe, it, expect } from 'vitest';
import { RunStreamRegistry } from './registry.js';

describe('RunStreamRegistry', () => {
  it('creates one broadcaster per run id, reuses on second get', () => {
    const r = new RunStreamRegistry();
    const a = r.getOrCreate(1);
    const b = r.getOrCreate(1);
    expect(a).toBe(b);
  });

  it('release removes it after end', () => {
    const r = new RunStreamRegistry();
    const bc = r.getOrCreate(7);
    bc.end();
    r.release(7);
    const fresh = r.getOrCreate(7);
    expect(fresh).not.toBe(bc);
  });

  it('getOrCreateState reuses the same broadcaster for the same run id', () => {
    const r = new RunStreamRegistry();
    const a = r.getOrCreateState(5);
    const b = r.getOrCreateState(5);
    expect(a).toBe(b);
  });

  it('getState returns undefined after release', () => {
    const r = new RunStreamRegistry();
    r.getOrCreateState(8);
    r.release(8);
    expect(r.getState(8)).toBeUndefined();
  });

  it('getOrCreateScreen returns the same ScreenState across calls for the same run id', () => {
    const r = new RunStreamRegistry();
    const a = r.getOrCreateScreen(42);
    const b = r.getOrCreateScreen(42);
    expect(a).toBe(b);
  });

  it('release() disposes the ScreenState and future getOrCreateScreen returns a fresh instance', () => {
    const r = new RunStreamRegistry();
    const first = r.getOrCreateScreen(99);
    r.release(99);
    const second = r.getOrCreateScreen(99);
    expect(second).not.toBe(first);
  });

  it('rebuildScreenFromLog: feeds file bytes through a new ScreenState that matches one fed the same bytes live', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ScreenState } = await import('./screen.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-screen-'));
    const logPath = path.join(dir, 'run.log');
    const payload = new TextEncoder().encode(
      'hello\r\n\x1b[31mred\x1b[0m\r\nline three\r\n'
    );
    fs.writeFileSync(logPath, payload);

    const live = new ScreenState(80, 24);
    await live.write(payload);

    const r = new RunStreamRegistry();
    const rebuilt = await r.rebuildScreenFromLog(1, logPath, 80, 24);
    expect(rebuilt.serialize()).toBe(live.serialize());

    live.dispose();
    r.release(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rebuildScreenFromLog: missing log file yields an empty fresh ScreenState without throwing', async () => {
    const r = new RunStreamRegistry();
    const screen = await r.rebuildScreenFromLog(1234, '/tmp/fbi-nonexistent-never-created.log', 80, 24);
    expect(screen.cols).toBe(80);
    expect(screen.rows).toBe(24);
    // An empty ScreenState should serialize to something that, re-parsed,
    // still serializes equivalently (idempotent empty snapshot).
    const again = new (await import('./screen.js')).ScreenState(80, 24);
    expect(screen.serialize()).toBe(again.serialize());
    r.release(1234);
    again.dispose();
  });

  it('rebuildScreenFromLog dedups concurrent calls for the same runId', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-screen-dedup-'));
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, new TextEncoder().encode('hello\r\n'));

    const r = new RunStreamRegistry();
    const [a, b] = await Promise.all([
      r.rebuildScreenFromLog(7, logPath, 80, 24),
      r.rebuildScreenFromLog(7, logPath, 80, 24),
    ]);
    expect(a).toBe(b);
    r.release(7);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
