import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TitleWatcher } from './titleWatcher.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-titlew-')); }
async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

describe('TitleWatcher', () => {
  it('does not fire before the file appears', async () => {
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: path.join(tmp(), 'session-name'), pollMs: 30, onTitle, onError: () => {} });
    w.start(); await sleep(100); await w.stop();
    expect(onTitle).not.toHaveBeenCalled();
  });
  it('fires once with trimmed+truncated value when the file appears', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, '   Fix auth race   ');
    await sleep(120); await w.stop();
    expect(onTitle).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledWith('Fix auth race');
  });
  it('de-duplicates identical values', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'Alpha'); await sleep(100);
    fs.writeFileSync(p, 'Alpha'); await sleep(100); await w.stop();
    expect(onTitle).toHaveBeenCalledTimes(1);
  });
  it('fires again when the value changes', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'Alpha'); await sleep(100);
    fs.writeFileSync(p, 'Beta'); await sleep(100); await w.stop();
    expect(onTitle.mock.calls.map((c) => c[0])).toEqual(['Alpha', 'Beta']);
  });
  it('truncates to 80 chars', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'x'.repeat(200)); await sleep(100); await w.stop();
    expect(onTitle.mock.calls[0][0]).toHaveLength(80);
  });
  it('skips empty-after-trim content', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, '   \n  '); await sleep(100);
    fs.writeFileSync(p, 'Real name'); await sleep(100); await w.stop();
    expect(onTitle).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledWith('Real name');
  });
  it('forwards non-ENOENT read errors to onError', async () => {
    const p = path.join(tmp(), 'session-name');
    fs.mkdirSync(p);  // make it a directory → EISDIR
    const onTitle = vi.fn();
    const onError = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError });
    w.start(); await sleep(100); await w.stop();
    expect(onTitle).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
