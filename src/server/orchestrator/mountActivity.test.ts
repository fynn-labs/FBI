import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sumJsonlSizes } from './mountActivity.js';

describe('sumJsonlSizes', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-mount-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('returns 0 for an empty dir', () => {
    expect(sumJsonlSizes(dir)).toBe(0);
  });

  it('sums .jsonl file sizes across nested dirs', () => {
    fs.writeFileSync(path.join(dir, 'a.jsonl'), 'x'.repeat(10));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'b.jsonl'), 'y'.repeat(7));
    fs.writeFileSync(path.join(dir, 'nested', 'ignore.txt'), 'z'.repeat(5));
    expect(sumJsonlSizes(dir)).toBe(17);
  });

  it('returns 0 when the dir does not exist', () => {
    expect(sumJsonlSizes(path.join(dir, 'missing'))).toBe(0);
  });
});
