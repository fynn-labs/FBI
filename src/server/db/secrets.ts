import type { DB } from './index.js';
import type { SecretName } from '../../shared/types.js';
import { encrypt, decrypt } from '../crypto.js';

export class SecretsRepo {
  constructor(private db: DB, private key: Buffer) {}

  upsert(projectId: number, name: string, value: string): void {
    const ct = Buffer.from(encrypt(this.key, value));
    this.db
      .prepare(
        `INSERT INTO project_secrets (project_id, name, value_enc, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, name)
         DO UPDATE SET value_enc = excluded.value_enc, created_at = excluded.created_at`
      )
      .run(projectId, name, ct, Date.now());
  }

  list(projectId: number): SecretName[] {
    return this.db
      .prepare(
        'SELECT name, created_at FROM project_secrets WHERE project_id = ? ORDER BY name'
      )
      .all(projectId) as SecretName[];
  }

  remove(projectId: number, name: string): void {
    this.db
      .prepare('DELETE FROM project_secrets WHERE project_id = ? AND name = ?')
      .run(projectId, name);
  }

  decryptAll(projectId: number): Record<string, string> {
    const rows = this.db
      .prepare(
        'SELECT name, value_enc FROM project_secrets WHERE project_id = ?'
      )
      .all(projectId) as Array<{ name: string; value_enc: Buffer }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.name] = decrypt(this.key, r.value_enc);
    return out;
  }
}
