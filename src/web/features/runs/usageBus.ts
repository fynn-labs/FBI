import type { UsageSnapshot, RateLimitState } from '@shared/types.js';

type UsageListener = (runId: number, snapshot: UsageSnapshot) => void;
type RlListener = (runId: number, snapshot: RateLimitState) => void;

const usageListeners = new Set<UsageListener>();
const rlListeners = new Set<RlListener>();

export function publishUsage(runId: number, s: UsageSnapshot): void {
  for (const l of usageListeners) l(runId, s);
}
export function publishRateLimit(runId: number, s: RateLimitState): void {
  for (const l of rlListeners) l(runId, s);
}
export function subscribeUsage(l: UsageListener): () => void {
  usageListeners.add(l);
  return () => { usageListeners.delete(l); };
}
export function subscribeRateLimit(l: RlListener): () => void {
  rlListeners.add(l);
  return () => { rlListeners.delete(l); };
}
