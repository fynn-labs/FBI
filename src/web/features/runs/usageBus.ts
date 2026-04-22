import type { UsageSnapshot, RateLimitState, RunWsStateMessage } from '@shared/types.js';

type UsageListener = (runId: number, snapshot: UsageSnapshot) => void;
type RlListener = (runId: number, snapshot: RateLimitState) => void;
type StateListener = (runId: number, frame: RunWsStateMessage) => void;

const usageListeners = new Set<UsageListener>();
const rlListeners = new Set<RlListener>();
const stateListeners = new Set<StateListener>();

export function publishUsage(runId: number, s: UsageSnapshot): void {
  for (const l of usageListeners) l(runId, s);
}
export function publishRateLimit(runId: number, s: RateLimitState): void {
  for (const l of rlListeners) l(runId, s);
}
export function publishState(runId: number, frame: RunWsStateMessage): void {
  for (const l of stateListeners) l(runId, frame);
}
export function subscribeUsage(l: UsageListener): () => void {
  usageListeners.add(l);
  return () => { usageListeners.delete(l); };
}
export function subscribeRateLimit(l: RlListener): () => void {
  rlListeners.add(l);
  return () => { rlListeners.delete(l); };
}
export function subscribeState(l: StateListener): () => void {
  stateListeners.add(l);
  return () => { stateListeners.delete(l); };
}
