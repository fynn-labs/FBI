import type { DB } from './index.js';
import type { Settings } from '../../shared/types.js';

interface SettingsRow {
  id: number;
  global_prompt: string;
  notifications_enabled: number;
  updated_at: number;
}

export class SettingsRepo {
  constructor(private db: DB) {}

  get(): Settings {
    const row = this.db
      .prepare('SELECT * FROM settings WHERE id = 1')
      .get() as SettingsRow | undefined;
    if (!row) {
      const now = Date.now();
      this.db
        .prepare(
          'INSERT INTO settings (id, global_prompt, notifications_enabled, updated_at) VALUES (1, ?, 1, ?)'
        )
        .run('', now);
      return { global_prompt: '', notifications_enabled: true, updated_at: now };
    }
    return {
      global_prompt: row.global_prompt,
      notifications_enabled: row.notifications_enabled === 1,
      updated_at: row.updated_at,
    };
  }

  update(patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
  }): Settings {
    const existing = this.get();
    const merged = {
      global_prompt: patch.global_prompt ?? existing.global_prompt,
      notifications_enabled:
        patch.notifications_enabled ?? existing.notifications_enabled,
      updated_at: Date.now(),
    };
    this.db
      .prepare(
        'UPDATE settings SET global_prompt = ?, notifications_enabled = ?, updated_at = ? WHERE id = 1'
      )
      .run(
        merged.global_prompt,
        merged.notifications_enabled ? 1 : 0,
        merged.updated_at
      );
    return merged;
  }
}
