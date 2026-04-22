import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';
import { SecretsEditor } from '../components/SecretsEditor.js';

export function ProjectDetailPage() {
  const { id } = useParams();
  const pid = Number(id);
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(() => {
    void api.getProject(pid).then(setProject);
    void api.listProjectRuns(pid).then(setRuns);
  }, [pid]);

  if (!project) return <div>Loading…</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 font-mono">{project.repo_url}</p>
        </div>
        <div className="flex gap-2">
          <Link
            to={`/projects/${pid}/edit`}
            className="border px-3 py-1 rounded dark:border-gray-600 dark:text-gray-200"
          >
            Edit
          </Link>
          <Link
            to={`/projects/${pid}/runs/new`}
            className="bg-blue-600 text-white px-3 py-1 rounded dark:bg-blue-500"
          >
            New Run
          </Link>
        </div>
      </div>

      <SecretsEditor projectId={pid} />

      <section className="bg-white border rounded p-4 dark:bg-gray-700 dark:border-gray-600">
        <h2 className="font-semibold mb-2">Runs</h2>
        <ul className="divide-y dark:divide-gray-700">
          {runs.length === 0 && <li className="text-gray-500 dark:text-gray-400">No runs yet</li>}
          {runs.map((r) => (
            <li key={r.id} className="py-2 flex items-center justify-between">
              <Link to={`/runs/${r.id}`} className="text-blue-700 dark:text-blue-400">
                Run #{r.id} · {new Date(r.created_at).toLocaleString()}
              </Link>
              <StateBadge state={r.state} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
