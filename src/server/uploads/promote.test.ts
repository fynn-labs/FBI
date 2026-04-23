import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promoteDraft } from './promote.js';

function mk(): { base: string; draftDir: string; runsDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-promote-'));
  return {
    base,
    draftDir: path.join(base, 'draft-uploads'),
    runsDir: path.join(base, 'runs'),
  };
}

describe('promoteDraft', () => {
  it('moves files from draft-uploads/<token>/ to runs/<id>/uploads/', async () => {
    const { draftDir, runsDir } = mk();
    const token = 'a'.repeat(32);
    fs.mkdirSync(path.join(draftDir, token), { recursive: true });
    fs.writeFileSync(path.join(draftDir, token, 'foo.csv'), 'hello');

    const promoted = await promoteDraft({ draftDir, runsDir, token, runId: 7 });

    expect(promoted).toEqual([{ filename: 'foo.csv', size: 5 }]);
    expect(fs.existsSync(path.join(draftDir, token))).toBe(false);
    expect(fs.readFileSync(path.join(runsDir, '7', 'uploads', 'foo.csv'), 'utf8')).toBe('hello');
  });

  it('renames on collision inside the destination', async () => {
    const { draftDir, runsDir } = mk();
    const token = 'b'.repeat(32);
    fs.mkdirSync(path.join(runsDir, '9', 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(runsDir, '9', 'uploads', 'a.txt'), 'existing');
    fs.mkdirSync(path.join(draftDir, token), { recursive: true });
    fs.writeFileSync(path.join(draftDir, token, 'a.txt'), 'new');

    const promoted = await promoteDraft({ draftDir, runsDir, token, runId: 9 });
    expect(promoted.map(p => p.filename)).toEqual(['a (1).txt']);
    expect(fs.readFileSync(path.join(runsDir, '9', 'uploads', 'a.txt'), 'utf8')).toBe('existing');
    expect(fs.readFileSync(path.join(runsDir, '9', 'uploads', 'a (1).txt'), 'utf8')).toBe('new');
  });

  it('throws when the token directory does not exist', async () => {
    const { draftDir, runsDir } = mk();
    await expect(promoteDraft({ draftDir, runsDir, token: 'c'.repeat(32), runId: 1 }))
      .rejects.toThrow();
  });
});
