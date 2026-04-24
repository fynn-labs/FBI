import { useEffect, useState } from 'react';

/**
 * Lightweight publish/subscribe for the app's primary websocket connection
 * state. Updated by useRunWatcher (which owns the /api/ws/states connection),
 * consumed by the status bar.
 */
export type ConnState = 'connecting' | 'connected' | 'disconnected';

type Listener = (s: ConnState) => void;

let current: ConnState = 'connecting';
const listeners = new Set<Listener>();

export function getConnectionState(): ConnState {
  return current;
}

export function setConnectionState(s: ConnState): void {
  if (s === current) return;
  current = s;
  for (const l of listeners) l(s);
}

export function onConnectionState(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function _resetConnectionStateForTest(): void {
  current = 'connecting';
  listeners.clear();
}

export function useConnectionState(): ConnState {
  const [s, setS] = useState<ConnState>(() => getConnectionState());
  useEffect(() => onConnectionState(setS), []);
  return s;
}
