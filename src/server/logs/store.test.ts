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

  it('byteSize returns file size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    fs.writeFileSync(p, Buffer.from('0123456789'));
    expect(LogStore.byteSize(p)).toBe(10);
  });

  it('byteSize returns 0 for missing file', () => {
    expect(LogStore.byteSize('/nonexistent/x')).toBe(0);
  });

  it('readRange returns exact bytes for a valid range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    fs.writeFileSync(p, Buffer.from('abcdefghij'));
    expect(Buffer.from(LogStore.readRange(p, 2, 5)).toString()).toBe('cdef');
    // Inclusive end:
    expect(Buffer.from(LogStore.readRange(p, 0, 10)).toString()).toBe('abcdefghij');
  });

  it('readRange clamps to file size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    fs.writeFileSync(p, Buffer.from('abc'));
    // End past EOF → clamped.
    expect(Buffer.from(LogStore.readRange(p, 1, 100)).toString()).toBe('bc');
    // Start past EOF → empty.
    expect(LogStore.readRange(p, 100, 200).length).toBe(0);
  });

  it('readRange returns empty for missing file', () => {
    expect(LogStore.readRange('/nonexistent/x', 0, 100).length).toBe(0);
  });

  it('byteSize + readRange reflect unflushed appends from an open LogStore', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    const s = new LogStore(p);
    s.append(Buffer.from('hello '));
    s.append(Buffer.from('world'));
    // Writer is still open — both static helpers must see the bytes.
    expect(LogStore.byteSize(p)).toBe(11);
    expect(Buffer.from(LogStore.readRange(p, 0, 10)).toString()).toBe('hello world');
    // A live reader of a suffix range works the same:
    expect(Buffer.from(LogStore.readRange(p, 6, 10)).toString()).toBe('world');
    s.close();
  });
});
