import { useEffect, useState } from 'react';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { EmptyState, LoadingState, ErrorState } from '@ui/patterns/index.js';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RunsList } from '../features/runs/RunsList.js';
import { ProjectHeader } from '../features/projects/ProjectHeader.js';

export function ProjectDetailPage() {
  const { id } = useParams();
  const pid = Number(id);
  const location = useLocation();
  const hasChildRoute = location.pathname.replace(/\/$/, '') !== `/projects/${pid}`;
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadRuns = () => api.listProjectRuns(pid)
      .then((r) => { if (!cancelled) setRuns(r); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    void api.getProject(pid).then((p) => { if (!cancelled) setProject(p); });
    loadRuns();
    const t = setInterval(loadRuns, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pid]);

  if (error) return <ErrorState message={error} />;
  if (!project || !runs) return <LoadingState label="Loading project…" />;

  return (
    <SplitPane
      leftWidth="360px"
      left={
        <div className="h-full flex flex-col min-h-0">
          <ProjectHeader project={project} />
          <div className="flex-1 min-h-0"><RunsList runs={runs} toHref={(r) => `/projects/${pid}/runs/${r.id}`} /></div>
        </div>
      }
      right={
        hasChildRoute ? <Outlet /> : (
          <div className="h-full flex items-center justify-center">
            <EmptyState title="Select a run" description="Or create a new run for this project." />
          </div>
        )
      }
    />
  );
}
