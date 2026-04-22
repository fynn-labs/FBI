import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LogStore } from './store.js';

describe('LogStore', () => {
  it('appends bytes and reads them back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    const s = new LogStore(p);
    s.append(Buffer.from('hello '));
    s.append(Buffer.from('world'));
    s.close();
    expect(fs.readFileSync(p, 'utf8')).toBe('hello world');
  });

  it('readAll returns contents as Uint8Array', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    fs.writeFileSync(p, Buffer.from('abc'));
    expect(Buffer.from(LogStore.readAll(p)).toString()).toBe('abc');
  });

  it('readAll returns empty if missing', () => {
    expect(LogStore.readAll('/nonexistent/x').length).toBe(0);
  });
});
