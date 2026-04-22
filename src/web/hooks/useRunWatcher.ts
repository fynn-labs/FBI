import { useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { notifyComplete, installFocusReset } from '../lib/notifications.js';

const POLL_MS = 5000;

export function useRunWatcher(enabled: boolean) {
  const prev = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    const dispose = installFocusReset();
    let stopped = false;
    const tick = async () => {
      try {
        const running = await api.listRuns('running');
        const nowIds = new Set(running.map((r) => r.id));
        const finishedIds: number[] = [];
        prev.current.forEach((id) => {
          if (!nowIds.has(id)) finishedIds.push(id);
        });
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
      } catch { /* swallow — next tick will retry */ }
      if (!stopped) setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { stopped = true; dispose(); };
  }, [enabled]);
}
