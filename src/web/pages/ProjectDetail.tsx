import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { EmptyState, LoadingState, ErrorState } from '@ui/patterns/index.js';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RunsList } from '../features/runs/RunsList.js';
import { ProjectHeader } from '../features/projects/ProjectHeader.js';
import { getLastRunForProject, setLastRunForProject } from '../features/runs/lastRun.js';
import { useIsNarrow } from '../hooks/useIsNarrow.js';

export function ProjectDetailPage() {
  const { id, rid } = useParams();
  const pid = Number(id);
  const location = useLocation();
  const hasChildRoute = location.pathname.replace(/\/$/, '') !== `/projects/${pid}`;
  const currentRunId = rid ? Number(rid) : null;
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  const redirectedRef = useRef(false);
  const narrow = useIsNarrow();

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const is404 = (e: unknown) => {
      const msg = String(e);
      return msg.includes('HTTP 404') || msg.includes(' 404 ');
    };

    void api.getProject(pid)
      .then((p) => { if (!cancelled) setProject(p); })
      .catch((e) => {
        if (!cancelled) {
          if (is404(e)) {
            setError(`Project #${pid} not found`);
            cancelled = true;
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
          }
        }
      });

    const loadRuns = () => api.listProjectRuns(pid)
      .then((r) => { if (!cancelled) setRuns(r); })
      .catch((e) => {
        if (!cancelled) {
          if (is404(e)) {
            setError(`Project #${pid} not found`);
            cancelled = true;
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
          } else {
            setError(String(e));
          }
        }
      });

    loadRuns();
    intervalId = setInterval(loadRuns, 5000);
    return () => { cancelled = true; if (intervalId !== null) clearInterval(intervalId); };
  }, [pid]);

  // Remember the current run id whenever it changes.
  useEffect(() => {
    if (rid) setLastRunForProject(pid, Number(rid));
  }, [pid, rid]);

  // Auto-redirect to the last-viewed run when no run is selected.
  useEffect(() => {
    if (redirectedRef.current) return;
    if (hasChildRoute) return;
    if (!runs || runs.length === 0) return;
    const lastId = getLastRunForProject(pid);
    if (lastId == null) return;
    if (!runs.some((r) => r.id === lastId)) return;
    redirectedRef.current = true;
    nav(`/projects/${pid}/runs/${lastId}`, { replace: true });
  }, [runs, hasChildRoute, pid, nav]);

  if (error) return <ErrorState message={error} />;
  if (!project || !runs) return <LoadingState label="Loading project…" />;

  // Narrow: show only master list or only detail (stacked).
  if (narrow) {
    if (hasChildRoute) {
      return (
        <div className="h-full flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-border bg-surface shrink-0">
            <Link to={`/projects/${pid}`} className="text-[12px]">← Back to project</Link>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <Outlet />
          </div>
        </div>
      );
    }
    return (
      <div className="h-full flex flex-col min-h-0">
        <ProjectHeader project={project} />
        <div className="flex-1 min-h-0 overflow-auto">
          <RunsList runs={runs} toHref={(r) => `/projects/${pid}/runs/${r.id}`} currentId={currentRunId} />
        </div>
      </div>
    );
  }

  return (
    <SplitPane
      leftWidth="360px"
      storageKey="project-detail"
      left={
        <div className="h-full flex flex-col min-h-0">
          <ProjectHeader project={project} />
          <div className="flex-1 min-h-0"><RunsList runs={runs} toHref={(r) => `/projects/${pid}/runs/${r.id}`} currentId={currentRunId} /></div>
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
