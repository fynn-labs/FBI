import type { MirrorStatus } from '../../shared/types.js';

export function parseMirrorStatus(raw: string): MirrorStatus {
  const t = raw.trim();
  if (t === 'ok') return 'ok';
  if (t === 'diverged') return 'diverged';
  if (t === 'local_only') return 'local_only';
  return null;
}
