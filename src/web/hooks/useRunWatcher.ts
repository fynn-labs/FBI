import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import {
  notifyComplete, notifyWaiting, clearWaitingBadge, installFocusReset,
} from '../lib/notifications.js';
import type { RunState } from '@shared/types.js';

type Listener = (map: Map<number, number>) => void;

let lastRunning = new Map<number, number>();
let lastWaiting = new Map<number, number>();
const runningListeners = new Set<Listener>();
const waitingListeners = new Set<Listener>();

export function _publishRunning(map: Map<number, number>) {
  lastRunning = map;
  for (const l of runningListeners) l(map);
}

export function _publishWaiting(map: Map<number, number>) {
  lastWaiting = map;
  for (const l of waitingListeners) l(map);
}

export function useRunningCounts(): Map<number, number> {
  const [m, setM] = useState(lastRunning);
  useEffect(() => {
    const l: Listener = (x) => setM(new Map(x));
    runningListeners.add(l);
    return () => { runningListeners.delete(l); };
  }, []);
  return m;
}

export function useWaitingCounts(): Map<number, number> {
  const [m, setM] = useState(lastWaiting);
  useEffect(() => {
    const l: Listener = (x) => setM(new Map(x));
    waitingListeners.add(l);
    return () => { waitingListeners.delete(l); };
  }, []);
  return m;
}

interface GlobalStateFrame {
  type: 'state';
  run_id: number;
  project_id: number;
  state: RunState;
}

const isTerminal = (s: RunState) =>
  s === 'succeeded' || s === 'failed' || s === 'cancelled';

function statesUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/ws/states`;
}

function publishCountsFromMap(runs: Map<number, { state: RunState; project_id: number }>) {
  const running = new Map<number, number>();
  const waiting = new Map<number, number>();
  for (const { state, project_id } of runs.values()) {
    if (state === 'running') running.set(project_id, (running.get(project_id) ?? 0) + 1);
    else if (state === 'waiting') waiting.set(project_id, (waiting.get(project_id) ?? 0) + 1);
  }
  _publishRunning(running);
  _publishWaiting(waiting);
}

export function useRunWatcher(enabled: boolean) {
  useEffect(() => {
    const dispose = enabled ? installFocusReset() : () => {};
    const runs = new Map<number, { state: RunState; project_id: number }>();
    let seeding = true;
    let ws: WebSocket | null = null;
    let stopped = false;

    const seed = async () => {
      seeding = true;
      try {
        const all = await api.listRuns();
        runs.clear();
        for (const r of all) runs.set(r.id, { state: r.state, project_id: r.project_id });
        publishCountsFromMap(runs);
      } catch { /* swallow; reconnect retry will re-seed */ }
      seeding = false;
    };

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(statesUrl());
      ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data as string) as GlobalStateFrame;
        const prev = runs.get(msg.run_id)?.state;
        runs.set(msg.run_id, { state: msg.state, project_id: msg.project_id });
        publishCountsFromMap(runs);
        if (seeding || !enabled) return;
        if (prev === 'running' && msg.state === 'waiting') {
          const proj = await api.getProject(msg.project_id).catch(() => null);
          void notifyWaiting({ id: msg.run_id, project_name: proj?.name });
        } else if (prev === 'waiting' && msg.state !== 'waiting') {
          clearWaitingBadge(msg.run_id);
        }
        if (isTerminal(msg.state) && !isTerminal(prev ?? 'queued')) {
          const proj = await api.getProject(msg.project_id).catch(() => null);
          void notifyComplete({
            id: msg.run_id,
            state: msg.state as 'succeeded' | 'failed' | 'cancelled',
            project_name: proj?.name,
          });
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setTimeout(() => { void seed().then(connect); }, 1000);
      };
    };

    void seed().then(connect);
    return () => {
      stopped = true;
      ws?.close();
      dispose();
    };
  }, [enabled]);
}
