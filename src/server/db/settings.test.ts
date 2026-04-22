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

  it('reads and updates global_marketplaces and global_plugins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    expect(settings.get().global_marketplaces).toEqual([]);
    expect(settings.get().global_plugins).toEqual([]);
    settings.update({ global_marketplaces: ['https://reg.example.com'], global_plugins: ['my-plugin@reg'] });
    expect(settings.get().global_marketplaces).toEqual(['https://reg.example.com']);
    expect(settings.get().global_plugins).toEqual(['my-plugin@reg']);
  });
});

describe('startup migration pattern', () => {
  it('migrates env-var values into empty DB columns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const repo = new SettingsRepo(db);

    // Simulate: FBI_DEFAULT_MARKETPLACES=https://r.example.com, DB is empty
    const legacyMarketplaces = ['https://r.example.com'];
    const current = repo.get();
    const patch: { global_marketplaces?: string[]; global_plugins?: string[] } = {};
    if (legacyMarketplaces.length > 0 && current.global_marketplaces.length === 0)
      patch.global_marketplaces = legacyMarketplaces;
    if (Object.keys(patch).length > 0) repo.update(patch);

    expect(repo.get().global_marketplaces).toEqual(['https://r.example.com']);
    expect(repo.get().global_plugins).toEqual([]);
  });

  it('does not overwrite existing DB values with env-var values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const repo = new SettingsRepo(db);

    // Pre-populate
    repo.update({ global_marketplaces: ['https://existing.com'] });

    // Simulate migration attempt with a different env-var value
    const legacyMarketplaces = ['https://different.com'];
    const current = repo.get();
    const patch: { global_marketplaces?: string[] } = {};
    if (legacyMarketplaces.length > 0 && current.global_marketplaces.length === 0)
      patch.global_marketplaces = legacyMarketplaces;
    if (Object.keys(patch).length > 0) repo.update(patch);

    // Should NOT have been overwritten
    expect(repo.get().global_marketplaces).toEqual(['https://existing.com']);
  });
});

describe('SettingsRepo auto-resume', () => {
  it('returns defaults on fresh DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    const s = settings.get();
    expect(s.auto_resume_enabled).toBe(true);
    expect(s.auto_resume_max_attempts).toBe(5);
  });

  it('patches and reads back both fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    settings.update({ auto_resume_enabled: false, auto_resume_max_attempts: 3 });
    const s = settings.get();
    expect(s.auto_resume_enabled).toBe(false);
    expect(s.auto_resume_max_attempts).toBe(3);
  });
});
