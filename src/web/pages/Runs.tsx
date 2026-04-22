import { useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { EmptyState, LoadingState, ErrorState } from '@ui/patterns/index.js';
import { KeyboardHint } from '@ui/patterns/KeyboardHint.js';
import type { Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RunsList } from '../features/runs/RunsList.js';
import { getLastRunGlobal, setLastRunGlobal } from '../features/runs/lastRun.js';

export function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = useParams();
  const nav = useNavigate();
  const redirectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.listRuns()
      .then((r) => { if (!cancelled) setRuns(r); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Remember the current run id whenever it changes.
  useEffect(() => {
    if (params.id) setLastRunGlobal(Number(params.id));
  }, [params.id]);

  // Auto-redirect to the last-viewed run when no run is selected.
  useEffect(() => {
    if (redirectedRef.current) return;
    if (params.id) return;
    if (!runs || runs.length === 0) return;
    const lastId = getLastRunGlobal();
    if (lastId == null) return;
    if (!runs.some((r) => r.id === lastId)) return;
    redirectedRef.current = true;
    nav(`/runs/${lastId}`, { replace: true });
  }, [runs, params.id, nav]);

  if (error) return <ErrorState message={error} />;
  if (!runs) return <LoadingState label="Loading runs…" />;

  return (
    <SplitPane
      leftWidth="360px"
      storageKey="runs"
      left={<RunsList runs={runs} toHref={(r) => `/runs/${r.id}`} currentId={params.id ? Number(params.id) : null} />}
      right={
        params.id ? <Outlet /> : (
          <div className="h-full flex items-center justify-center">
            <EmptyState
              title="Select a run"
              description="Pick a run from the list, or create a new one."
              hint={<KeyboardHint keys={['j', '/', 'k']} label="navigate" />}
            />
          </div>
        )
      }
    />
  );
}
