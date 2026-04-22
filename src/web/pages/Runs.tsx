import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { EmptyState, LoadingState, ErrorState } from '@ui/patterns/index.js';
import { KeyboardHint } from '@ui/patterns/KeyboardHint.js';
import type { Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RunsList } from '../features/runs/RunsList.js';

export function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = useParams();

  useEffect(() => {
    let cancelled = false;
    const load = () => api.listRuns()
      .then((r) => { if (!cancelled) setRuns(r); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!runs) return <LoadingState label="Loading runs…" />;

  return (
    <SplitPane
      leftWidth="360px"
      left={<RunsList runs={runs} toHref={(r) => `/runs/${r.id}`} />}
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
