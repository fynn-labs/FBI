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
