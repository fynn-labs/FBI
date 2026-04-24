import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WipRepo } from '../orchestrator/wipRepo.js';

describe('WipRepo eager init', () => {
  it('creates the bare repo synchronously for a given runId', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
    const repo = new WipRepo(root);
    repo.init(42);
    expect(fs.existsSync(path.join(root, '42', 'wip.git', 'HEAD'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('remove() is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
    const repo = new WipRepo(root);
    repo.init(7);
    repo.remove(7);
    repo.remove(7);
    expect(fs.existsSync(path.join(root, '7'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
