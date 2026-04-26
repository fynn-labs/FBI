import { useEffect, useState } from 'react';
import type {
  UsageSnapshot, RunWsStateMessage, RunWsTitleMessage, ChangesPayload,
  RunWsFocusStateMessage,
} from '@shared/types.js';

type UsageListener = (runId: number, snapshot: UsageSnapshot) => void;
type StateListener = (runId: number, frame: RunWsStateMessage) => void;
type TitleListener = (runId: number, frame: RunWsTitleMessage) => void;
type ChangesListener = (runId: number, payload: ChangesPayload) => void;
type FocusStateListener = (runId: number, frame: RunWsFocusStateMessage) => void;

const usageListeners = new Set<UsageListener>();
const stateListeners = new Set<StateListener>();
const titleListeners = new Set<TitleListener>();
const changesListeners = new Set<ChangesListener>();
const focusStateListeners = new Set<FocusStateListener>();

export function publishUsage(runId: number, s: UsageSnapshot): void {
  for (const l of usageListeners) l(runId, s);
}
export function publishState(runId: number, frame: RunWsStateMessage): void {
  for (const l of stateListeners) l(runId, frame);
}
export function publishTitle(runId: number, frame: RunWsTitleMessage): void {
  for (const l of titleListeners) l(runId, frame);
}
export function publishChanges(runId: number, payload: ChangesPayload): void {
  for (const l of changesListeners) l(runId, payload);
}
export function publishFocusState(runId: number, frame: RunWsFocusStateMessage): void {
  for (const l of focusStateListeners) l(runId, frame);
}
export function subscribeUsage(l: UsageListener): () => void {
  usageListeners.add(l);
  return () => { usageListeners.delete(l); };
}
export function subscribeState(l: StateListener): () => void {
  stateListeners.add(l);
  return () => { stateListeners.delete(l); };
}
export function subscribeTitle(l: TitleListener): () => void {
  titleListeners.add(l);
  return () => { titleListeners.delete(l); };
}
export function subscribeChanges(l: ChangesListener): () => void {
  changesListeners.add(l);
  return () => { changesListeners.delete(l); };
}
export function subscribeFocusState(l: FocusStateListener): () => void {
  focusStateListeners.add(l);
  return () => { focusStateListeners.delete(l); };
}

/**
 * React hook that returns the latest focus_state frame for a given run.
 * Returns null until the first focus_state event arrives for this run.
 */
export function useFocusState(runId: number): RunWsFocusStateMessage | null {
  const [state, setState] = useState<RunWsFocusStateMessage | null>(null);
  useEffect(() => {
    setState(null); // reset when runId changes
    return subscribeFocusState((id, frame) => {
      if (id === runId) setState(frame);
    });
  }, [runId]);
  return state;
}
