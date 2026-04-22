import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { SettingsRepo } from './settings.js';

describe('SettingsRepo', () => {
  it('reads and updates notifications_enabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    expect(settings.get().notifications_enabled).toBe(true);
    settings.update({ notifications_enabled: false });
    expect(settings.get().notifications_enabled).toBe(false);
  });

  it('reads defaults for new settings fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    const s = settings.get();
    expect(s.concurrency_warn_at).toBe(3);
    expect(s.image_gc_enabled).toBe(false);
    expect(s.last_gc_at).toBeNull();
  });

  it('updates concurrency_warn_at and image_gc_enabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    settings.update({ concurrency_warn_at: 5, image_gc_enabled: true });
    const s = settings.get();
    expect(s.concurrency_warn_at).toBe(5);
    expect(s.image_gc_enabled).toBe(true);
  });

  it('records last GC stats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    settings.recordGc({ at: 1234, count: 3, bytes: 2048 });
    const s = settings.get();
    expect(s.last_gc_at).toBe(1234);
    expect(s.last_gc_count).toBe(3);
    expect(s.last_gc_bytes).toBe(2048);
  });
});
