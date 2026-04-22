import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';

export function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listRuns()
      .then((data) => { if (!cancelled) setRuns(data); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="text-red-600">{error}</div>;
  if (!runs) return <div>Loading…</div>;
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">All Runs</h1>
      <ul className="divide-y bg-white border rounded dark:bg-gray-800 dark:border-gray-700 dark:divide-gray-700">
        {runs.length === 0 && <li className="p-4 text-gray-500 dark:text-gray-400">No runs yet</li>}
        {runs.map((r) => (
          <li key={r.id} className="p-3 flex justify-between items-center">
            <Link to={`/runs/${r.id}`} className="text-blue-700 dark:text-blue-400">
              Run #{r.id} (project {r.project_id}) — {new Date(r.created_at).toLocaleString()}
            </Link>
            <StateBadge state={r.state} />
          </li>
        ))}
      </ul>
    </div>
  );
}
