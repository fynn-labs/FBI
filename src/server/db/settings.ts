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
  global_marketplaces_json: string;
  global_plugins_json: string;
  auto_resume_enabled: number;
  auto_resume_max_attempts: number;
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
      global_marketplaces: JSON.parse(row.global_marketplaces_json || '[]') as string[],
      global_plugins: JSON.parse(row.global_plugins_json || '[]') as string[],
      auto_resume_enabled: row.auto_resume_enabled === 1,
      auto_resume_max_attempts: row.auto_resume_max_attempts ?? 5,
      updated_at: row.updated_at,
    };
  }

  update(patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
    concurrency_warn_at?: number;
    image_gc_enabled?: boolean;
    global_marketplaces?: string[];
    global_plugins?: string[];
    auto_resume_enabled?: boolean;
    auto_resume_max_attempts?: number;
  }): Settings {
    const existing = this.get();
    const merged = {
      global_prompt: patch.global_prompt ?? existing.global_prompt,
      notifications_enabled: patch.notifications_enabled ?? existing.notifications_enabled,
      concurrency_warn_at: patch.concurrency_warn_at ?? existing.concurrency_warn_at,
      image_gc_enabled: patch.image_gc_enabled ?? existing.image_gc_enabled,
      global_marketplaces: patch.global_marketplaces ?? existing.global_marketplaces,
      global_plugins: patch.global_plugins ?? existing.global_plugins,
      auto_resume_enabled: patch.auto_resume_enabled ?? existing.auto_resume_enabled,
      auto_resume_max_attempts: patch.auto_resume_max_attempts ?? existing.auto_resume_max_attempts,
    };
    const now = Date.now();
    this.db.prepare(
      `UPDATE settings SET
        global_prompt = ?, notifications_enabled = ?,
        concurrency_warn_at = ?, image_gc_enabled = ?,
        global_marketplaces_json = ?, global_plugins_json = ?,
        auto_resume_enabled = ?, auto_resume_max_attempts = ?,
        updated_at = ?
       WHERE id = 1`
    ).run(
      merged.global_prompt,
      merged.notifications_enabled ? 1 : 0,
      merged.concurrency_warn_at,
      merged.image_gc_enabled ? 1 : 0,
      JSON.stringify(merged.global_marketplaces),
      JSON.stringify(merged.global_plugins),
      merged.auto_resume_enabled ? 1 : 0,
      merged.auto_resume_max_attempts,
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
