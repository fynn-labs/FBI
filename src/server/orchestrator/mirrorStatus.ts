import type { MirrorStatus } from '../../shared/types.js';

export function parseMirrorStatus(raw: string): MirrorStatus {
  const t = raw.trim();
  if (t === 'ok') return 'ok';
  if (t === 'diverged') return 'diverged';
  return null;
}
