import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BranchNameWatcher } from './branchNameWatcher.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-branchw-')); }
async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

describe('BranchNameWatcher', () => {
  it('does not fire before the file appears', async () => {
    const onBranchName = vi.fn();
    const w = new BranchNameWatcher({ path: path.join(tmp(), 'branch-name'), pollMs: 30, onBranchName, onError: () => {} });
    w.start(); await sleep(100); await w.stop();
    expect(onBranchName).not.toHaveBeenCalled();
  });

  it('fires with trimmed value when the file appears', async () => {
    const p = path.join(tmp(), 'branch-name');
    const onBranchName = vi.fn();
    const w = new BranchNameWatcher({ path: p, pollMs: 30, onBranchName, onError: () => {} });
    w.start();
    fs.writeFileSync(p, '  feat/fbi-tunnel-rust  \n');
    await sleep(120); await w.stop();
    expect(onBranchName).toHaveBeenCalledTimes(1);
    expect(onBranchName).toHaveBeenCalledWith('feat/fbi-tunnel-rust');
  });

  it('ignores invalid branch names', async () => {
    const p = path.join(tmp(), 'branch-name');
    const onBranchName = vi.fn();
    const w = new BranchNameWatcher({ path: p, pollMs: 30, onBranchName, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'bad branch name!');
    await sleep(100); await w.stop();
    expect(onBranchName).not.toHaveBeenCalled();
  });

  it('de-duplicates identical values', async () => {
    const p = path.join(tmp(), 'branch-name');
    const onBranchName = vi.fn();
    const w = new BranchNameWatcher({ path: p, pollMs: 30, onBranchName, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'feat/my-branch'); await sleep(100);
    fs.writeFileSync(p, 'feat/my-branch'); await sleep(100); await w.stop();
    expect(onBranchName).toHaveBeenCalledTimes(1);
  });

  it('fires again when the value changes', async () => {
    const p = path.join(tmp(), 'branch-name');
    const onBranchName = vi.fn();
    const w = new BranchNameWatcher({ path: p, pollMs: 30, onBranchName, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'feat/alpha'); await sleep(100);
    fs.writeFileSync(p, 'feat/beta');  await sleep(100); await w.stop();
    expect(onBranchName).toHaveBeenCalledTimes(2);
    expect(onBranchName).toHaveBeenNthCalledWith(1, 'feat/alpha');
    expect(onBranchName).toHaveBeenNthCalledWith(2, 'feat/beta');
  });
});
