import type { UsageBucket, PacingVerdict } from '../shared/types.js';

export const KNOWN_BUCKET_WINDOWS: Record<string, number> = {
  five_hour:     5 * 3600 * 1000,
  weekly:        7 * 24 * 3600 * 1000,
  sonnet_weekly: 7 * 24 * 3600 * 1000,
};

export function derivePacing(bucket: UsageBucket, now: number): PacingVerdict {
  const windowStart = resolveWindowStart(bucket);
  if (windowStart == null || bucket.reset_at == null) {
    return { delta: 0, zone: 'none' };
  }
  const knownWin = KNOWN_BUCKET_WINDOWS[bucket.id];
  const duration = typeof knownWin === 'number' ? knownWin : bucket.reset_at - windowStart;
  if (duration <= 0) return { delta: 0, zone: 'none' };
  const elapsed = now - windowStart;
  const progress = elapsed / duration;
  if (progress < 0.05) return { delta: 0, zone: 'none' };

  const uExpected = Math.min(1, Math.max(0, progress));
  const delta = bucket.utilization - uExpected;
  const zone =
    delta <= -0.05 ? 'chill' :
    delta >=  0.10 ? 'hot'   :
    'on_track';
  return { delta, zone };
}

function resolveWindowStart(bucket: UsageBucket): number | null {
  if (bucket.window_started_at != null) return bucket.window_started_at;
  if (bucket.reset_at == null) return null;
  const win = KNOWN_BUCKET_WINDOWS[bucket.id];
  return typeof win === 'number' ? bucket.reset_at - win : null;
}
