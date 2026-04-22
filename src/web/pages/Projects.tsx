import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '@shared/types.js';
import { api } from '../lib/api.js';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="text-red-600">{error}</div>;
  if (!projects) return <div>Loading…</div>;
  if (projects.length === 0) {
    return (
      <div>
        <p className="mb-4">No projects yet.</p>
        <Link to="/projects/new" className="text-blue-600 underline">
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
          className="bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
        >
          New Project
        </Link>
      </div>
      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.id} className="bg-white border rounded p-4 flex justify-between">
            <div>
              <Link to={`/projects/${p.id}`} className="text-lg font-medium text-blue-700">
                {p.name}
              </Link>
              <p className="text-sm text-gray-500">{p.repo_url}</p>
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
