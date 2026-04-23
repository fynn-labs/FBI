import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sweepDraftUploads,
  sweepPartFiles,
  startDraftUploadsGc,
} from './draftUploads.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-hk-'));
}

describe('sweepDraftUploads', () => {
  it('deletes token directories older than 24h', async () => {
    const base = mkTmp();
    const old = path.join(base, 'aaaa');
    const fresh = path.join(base, 'bbbb');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(old, 'a.txt'), 'x');
    fs.writeFileSync(path.join(fresh, 'b.txt'), 'x');

    const now = Date.now();
    const oldMs = now - 25 * 60 * 60 * 1000;
    fs.utimesSync(old, oldMs / 1000, oldMs / 1000);

    await sweepDraftUploads(base, now);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('is a no-op if the base directory does not exist', async () => {
    await expect(sweepDraftUploads('/nonexistent/xyz', Date.now())).resolves.toBeUndefined();
  });
});

describe('sweepPartFiles', () => {
  it('removes .part files under runs/*/uploads and draft-uploads/*', async () => {
    const base = mkTmp();
    const runsDir = path.join(base, 'runs');
    const draftDir = path.join(base, 'draft-uploads');
    fs.mkdirSync(path.join(runsDir, '1', 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(draftDir, 'aaaa'), { recursive: true });
    fs.writeFileSync(path.join(runsDir, '1', 'uploads', 'x.part'), '');
    fs.writeFileSync(path.join(runsDir, '1', 'uploads', 'y.csv'), 'keep');
    fs.writeFileSync(path.join(draftDir, 'aaaa', 'z.part'), '');

    await sweepPartFiles(runsDir, draftDir);

    expect(fs.existsSync(path.join(runsDir, '1', 'uploads', 'x.part'))).toBe(false);
    expect(fs.existsSync(path.join(runsDir, '1', 'uploads', 'y.csv'))).toBe(true);
    expect(fs.existsSync(path.join(draftDir, 'aaaa', 'z.part'))).toBe(false);
  });
});

describe('startDraftUploadsGc', () => {
  it('runs both sweeps at startup and returns a stop function', async () => {
    const base = mkTmp();
    const runsDir = path.join(base, 'runs');
    const draftDir = path.join(base, 'draft-uploads');
    fs.mkdirSync(path.join(runsDir, '1', 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(draftDir, 'cccc'), { recursive: true });
    fs.writeFileSync(path.join(runsDir, '1', 'uploads', 'x.part'), '');
    const stop = startDraftUploadsGc({ runsDir, draftDir, intervalMs: 60_000 });
    await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(path.join(runsDir, '1', 'uploads', 'x.part'))).toBe(false);
    stop();
  });
});
