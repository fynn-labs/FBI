import type { DB } from './index.js';
import type { Settings } from '../../shared/types.js';

interface SettingsRow {
  id: number;
  global_prompt: string;
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
        .prepare('INSERT INTO settings (id, global_prompt, updated_at) VALUES (1, ?, ?)')
        .run('', now);
      return { global_prompt: '', updated_at: now };
    }
    return { global_prompt: row.global_prompt, updated_at: row.updated_at };
  }

  update(patch: { global_prompt?: string }): Settings {
    const existing = this.get();
    const merged = {
      global_prompt: patch.global_prompt ?? existing.global_prompt,
      updated_at: Date.now(),
    };
    this.db
      .prepare('UPDATE settings SET global_prompt = ?, updated_at = ? WHERE id = 1')
      .run(merged.global_prompt, merged.updated_at);
    return merged;
  }
}
