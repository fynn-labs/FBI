import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WipRepo } from './wipRepo.js';

describe('WipRepo lifecycle integration', () => {
  it('is torn down by remove after init', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiplc-'));
    const repo = new WipRepo(root);
    const p = repo.init(99);
    expect(fs.existsSync(p)).toBe(true);
    repo.remove(99);
    expect(fs.existsSync(p)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
