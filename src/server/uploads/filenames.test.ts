import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeFilename, resolveFilename, directoryBytes } from './filenames.js';

describe('sanitizeFilename', () => {
  it('accepts normal names including spaces, unicode, leading dots', () => {
    expect(sanitizeFilename('foo.csv')).toBe('foo.csv');
    expect(sanitizeFilename('My File (2).pdf')).toBe('My File (2).pdf');
    expect(sanitizeFilename('café.md')).toBe('café.md');
    expect(sanitizeFilename('.env')).toBe('.env');
  });

  it('rejects path separators', () => {
    expect(() => sanitizeFilename('a/b')).toThrow('invalid_filename');
    expect(() => sanitizeFilename('a\\b')).toThrow('invalid_filename');
  });

  it('rejects null bytes', () => {
    expect(() => sanitizeFilename('a\0b')).toThrow('invalid_filename');
  });

  it('rejects traversal', () => {
    expect(() => sanitizeFilename('..')).toThrow('invalid_filename');
    expect(() => sanitizeFilename('.')).toThrow('invalid_filename');
    expect(() => sanitizeFilename('..foo')).toThrow('invalid_filename');
  });

  it('rejects empty and oversized names', () => {
    expect(() => sanitizeFilename('')).toThrow('invalid_filename');
    expect(() => sanitizeFilename('a'.repeat(256))).toThrow('invalid_filename');
  });
});

describe('resolveFilename', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-fn-'));
  }

  it('returns the name unchanged when the directory is empty', () => {
    const dir = tmpDir();
    expect(resolveFilename(dir, 'foo.csv')).toBe('foo.csv');
  });

  it('suffixes on collision before the extension', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'foo.csv'), '');
    expect(resolveFilename(dir, 'foo.csv')).toBe('foo (1).csv');
    fs.writeFileSync(path.join(dir, 'foo (1).csv'), '');
    expect(resolveFilename(dir, 'foo.csv')).toBe('foo (2).csv');
  });

  it('suffixes at the end when there is no extension', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'Makefile'), '');
    expect(resolveFilename(dir, 'Makefile')).toBe('Makefile (1)');
  });

  it('ignores .part files when resolving', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'foo.csv.part'), '');
    expect(resolveFilename(dir, 'foo.csv')).toBe('foo.csv');
  });
});

describe('directoryBytes', () => {
  it('sums non-.part file sizes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-fn-'));
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(50));
    fs.writeFileSync(path.join(dir, 'c.part'), Buffer.alloc(999));
    expect(await directoryBytes(dir)).toBe(150);
  });

  it('returns 0 for a missing directory', async () => {
    expect(await directoryBytes('/nonexistent/xyz')).toBe(0);
  });
});
