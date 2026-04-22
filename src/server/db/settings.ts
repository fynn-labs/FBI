import type { DB } from './index.js';
import type { Settings } from '../../shared/types.js';

interface SettingsRow {
  id: number;
  global_prompt: string;
  notifications_enabled: number;
  concurrency_warn_at: number;
  image_gc_enabled: number;
  last_gc_at: number | null;
  last_gc_count: number | null;
  last_gc_bytes: number | null;
  updated_at: number;
}

export class SettingsRepo {
  constructor(private db: DB) {}

  get(): Settings {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow | undefined;
    if (!row) {
      const now = Date.now();
      this.db.prepare(
        `INSERT INTO settings (id, global_prompt, notifications_enabled, concurrency_warn_at, image_gc_enabled, updated_at)
         VALUES (1, '', 1, 3, 0, ?)`
      ).run(now);
      return this.get();
    }
    return {
      global_prompt: row.global_prompt,
      notifications_enabled: row.notifications_enabled === 1,
      concurrency_warn_at: row.concurrency_warn_at,
      image_gc_enabled: row.image_gc_enabled === 1,
      last_gc_at: row.last_gc_at,
      last_gc_count: row.last_gc_count,
      last_gc_bytes: row.last_gc_bytes,
      updated_at: row.updated_at,
    };
  }

  update(patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
    concurrency_warn_at?: number;
    image_gc_enabled?: boolean;
  }): Settings {
    const existing = this.get();
    const merged = {
      global_prompt: patch.global_prompt ?? existing.global_prompt,
      notifications_enabled: patch.notifications_enabled ?? existing.notifications_enabled,
      concurrency_warn_at: patch.concurrency_warn_at ?? existing.concurrency_warn_at,
      image_gc_enabled: patch.image_gc_enabled ?? existing.image_gc_enabled,
    };
    const now = Date.now();
    this.db.prepare(
      `UPDATE settings SET
        global_prompt = ?, notifications_enabled = ?,
        concurrency_warn_at = ?, image_gc_enabled = ?, updated_at = ?
       WHERE id = 1`
    ).run(
      merged.global_prompt,
      merged.notifications_enabled ? 1 : 0,
      merged.concurrency_warn_at,
      merged.image_gc_enabled ? 1 : 0,
      now,
    );
    return this.get();
  }

  recordGc(stats: { at: number; count: number; bytes: number }): void {
    this.db.prepare(
      'UPDATE settings SET last_gc_at = ?, last_gc_count = ?, last_gc_bytes = ? WHERE id = 1'
    ).run(stats.at, stats.count, stats.bytes);
  }
}
