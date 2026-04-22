import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '@shared/types.js';
import { api } from '../lib/api.js';
import { useRunningCounts } from '../hooks/useRunWatcher.js';
import { StateBadge } from '../components/StateBadge.js';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRunningCounts();

  useEffect(() => {
    let cancelled = false;
    api.listProjects()
      .then((data) => { if (!cancelled) setProjects(data); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="text-red-600">{error}</div>;
  if (!projects) return <div>Loading…</div>;
  if (projects.length === 0) {
    return (
      <div>
        <p className="mb-4">No projects yet.</p>
        <Link to="/projects/new" className="text-blue-600 underline dark:text-blue-400">
          Create one
        </Link>
      </div>
    );
  }
  return (
    <div>
      <div className="flex justify-between mb-4">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <Link
          to="/projects/new"
          className="bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
        >
          New Project
        </Link>
      </div>
      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.id} className="bg-white border rounded p-4 flex justify-between dark:bg-gray-700 dark:border-gray-600">
            <div>
              <div className="flex items-center flex-wrap gap-1">
                <Link to={`/projects/${p.id}`} className="text-lg font-medium text-blue-700 dark:text-blue-400">
                  {p.name}
                </Link>
                {running.get(p.id) ? (
                  <span className="ml-2 text-xs text-green-600 dark:text-green-400">
                    ● {running.get(p.id)} running
                  </span>
                ) : null}
                {p.last_run && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs">
                    <StateBadge state={p.last_run.state} />
                    <span className="text-gray-500">{relativeTime(p.last_run.created_at)}</span>
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{p.repo_url}</p>
            </div>
            <Link
              to={`/projects/${p.id}/runs/new`}
              className="self-center bg-gray-800 text-white px-3 py-1 rounded"
            >
              New Run
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
