import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOnBytes } from './onBytes.js';
import { LogStore } from './store.js';
import { Broadcaster } from './broadcaster.js';
import { ScreenState } from './screen.js';

describe('makeOnBytes', () => {
  it('fans one chunk out to store.append, broadcaster.publish, and screen.write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-onbytes-'));
    const store = new LogStore(path.join(dir, 'run.log'));
    const broadcaster = new Broadcaster();
    const screen = new ScreenState(80, 24);
    const received: Uint8Array[] = [];
    broadcaster.subscribe((c) => received.push(c));

    const appendSpy = vi.spyOn(store, 'append');
    const publishSpy = vi.spyOn(broadcaster, 'publish');
    const writeSpy = vi.spyOn(screen, 'write');

    const onBytes = makeOnBytes(store, broadcaster, screen);
    const chunk = new TextEncoder().encode('hello\r\n');
    onBytes(chunk);

    expect(appendSpy).toHaveBeenCalledWith(chunk);
    expect(publishSpy).toHaveBeenCalledWith(chunk);
    expect(writeSpy).toHaveBeenCalledWith(chunk);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(chunk);

    // Give ScreenState's async parser a tick to finish.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.serialize()).toContain('hello');

    store.close();
    screen.dispose();
  });

  it('swallows screen.write rejections so a misbehaving screen cannot break the broadcaster', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-onbytes-'));
    const store = new LogStore(path.join(dir, 'run.log'));
    const broadcaster = new Broadcaster();
    const screen = {
      write: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as ScreenState;

    const onBytes = makeOnBytes(store, broadcaster, screen);
    expect(() => onBytes(new Uint8Array([1, 2, 3]))).not.toThrow();

    store.close();
  });
});
