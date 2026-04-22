import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { notifyComplete, installFocusReset } from '../lib/notifications.js';

const POLL_MS = 5000;

type Listener = (map: Map<number, number>) => void;
let lastMap = new Map<number, number>();
const listeners = new Set<Listener>();

export function _publishRunning(map: Map<number, number>) {
  lastMap = map;
  for (const l of listeners) l(map);
}

export function useRunningCounts(): Map<number, number> {
  const [m, setM] = useState(lastMap);
  useEffect(() => {
    const l: Listener = (x) => setM(new Map(x));
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return m;
}

export function useRunWatcher(enabled: boolean) {
  const prev = useRef<Set<number>>(new Set());
  useEffect(() => {
    const dispose = enabled ? installFocusReset() : () => {};
    let stopped = false;
    const tick = async () => {
      try {
        const running = await api.listRuns('running');
        const nowIds = new Set(running.map((r) => r.id));
        const countsByProject = new Map<number, number>();
        for (const r of running) {
          countsByProject.set(r.project_id, (countsByProject.get(r.project_id) ?? 0) + 1);
        }
        _publishRunning(countsByProject);

        if (enabled) {
          const finishedIds: number[] = [];
          prev.current.forEach((id) => { if (!nowIds.has(id)) finishedIds.push(id); });
          prev.current = nowIds;
          for (const id of finishedIds) {
            const run = await api.getRun(id);
            if (run && (run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled')) {
              const proj = await api.getProject(run.project_id).catch(() => null);
              await notifyComplete({
                id: run.id,
                state: run.state,
                project_name: proj?.name,
              });
            }
          }
        } else {
          prev.current = nowIds;
        }
      } catch { /* swallow — next tick will retry */ }
      if (!stopped) setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { stopped = true; dispose(); };
  }, [enabled]);
}
