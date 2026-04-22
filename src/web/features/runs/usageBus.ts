import type { UsageSnapshot, RunWsStateMessage } from '@shared/types.js';

type UsageListener = (runId: number, snapshot: UsageSnapshot) => void;
type StateListener = (runId: number, frame: RunWsStateMessage) => void;

const usageListeners = new Set<UsageListener>();
const stateListeners = new Set<StateListener>();

export function publishUsage(runId: number, s: UsageSnapshot): void {
  for (const l of usageListeners) l(runId, s);
}
export function publishState(runId: number, frame: RunWsStateMessage): void {
  for (const l of stateListeners) l(runId, frame);
}
export function subscribeUsage(l: UsageListener): () => void {
  usageListeners.add(l);
  return () => { usageListeners.delete(l); };
}
export function subscribeState(l: StateListener): () => void {
  stateListeners.add(l);
  return () => { stateListeners.delete(l); };
}
