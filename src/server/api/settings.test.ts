import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { SettingsRepo } from '../db/settings.js';
import { registerSettingsRoutes } from './settings.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-settings-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const settings = new SettingsRepo(db);
  const app = Fastify();
  registerSettingsRoutes(app, {
    settings,
    runGc: async () => ({ deletedCount: 0, deletedBytes: 0 }),
  });
  return { app, settings };
}

describe('settings routes', () => {
  it('GET /api/settings returns defaults including auto_resume fields', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { auto_resume_enabled: boolean; auto_resume_max_attempts: number };
    expect(typeof body.auto_resume_enabled).toBe('boolean');
    expect(typeof body.auto_resume_max_attempts).toBe('number');
  });

  it('PATCH /api/settings rejects out-of-range auto_resume_max_attempts', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { auto_resume_max_attempts: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /api/settings updates auto_resume_enabled and auto_resume_max_attempts', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { auto_resume_enabled: true, auto_resume_max_attempts: 7 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { auto_resume_enabled: boolean; auto_resume_max_attempts: number };
    expect(body.auto_resume_enabled).toBe(true);
    expect(body.auto_resume_max_attempts).toBe(7);
  });

  it('PATCH /api/settings sets usage_notifications_enabled and GET reflects it', async () => {
    const { app } = setup();
    const patchRes = await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { usage_notifications_enabled: true },
    });
    expect(patchRes.statusCode).toBe(200);
    const patchBody = patchRes.json() as { usage_notifications_enabled: boolean };
    expect(patchBody.usage_notifications_enabled).toBe(true);

    const getRes = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json() as { usage_notifications_enabled: boolean };
    expect(getBody.usage_notifications_enabled).toBe(true);
  });
});
