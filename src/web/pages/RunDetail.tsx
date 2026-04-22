import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';
import { Terminal } from '../components/Terminal.js';

export function RunDetailPage() {
  const { id } = useParams();
  const runId = Number(id);
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.getRun(runId);
        if (alive) setRun(r);
      } catch { /* ignore */ }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [runId]);

  if (!run) return <div>Loading…</div>;

  async function cancel() {
    if (!confirm('Cancel this run?')) return;
    try {
      await api.deleteRun(runId);
      // polling loop will refresh the state within 3s
    } catch { /* ignore */ }
  }

  async function remove() {
    if (!confirm('Delete this run and its transcript?')) return;
    try {
      await api.deleteRun(runId);
      nav('/runs');
    } catch { /* ignore */ }
  }

  const interactive = run.state === 'running' || run.state === 'queued';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Run #{run.id}</h1>
        <StateBadge state={run.state} />
        {run.head_commit && (
          <code className="text-sm bg-gray-100 dark:bg-gray-700 rounded px-2 py-0.5">
            {run.branch_name} @ {run.head_commit.slice(0, 8)}
          </code>
        )}
        <div className="ml-auto flex gap-2">
          {run.state === 'running' && (
            <button onClick={cancel} className="bg-red-600 text-white px-3 py-1 rounded">
              Cancel
            </button>
          )}
          {run.state !== 'running' && run.state !== 'queued' && run.branch_name && (
            <button
              onClick={() =>
                nav(
                  `/projects/${run.project_id}/runs/new?branch=${encodeURIComponent(run.branch_name!)}`
                )
              }
              className="border px-3 py-1 rounded dark:border-gray-600 dark:text-gray-200"
            >
              Follow up
            </button>
          )}
          {run.state !== 'running' && (
            <button onClick={remove} className="border px-3 py-1 rounded dark:border-gray-600 dark:text-gray-200">
              Delete
            </button>
          )}
        </div>
      </div>
      <details className="bg-white border rounded p-3 text-sm dark:bg-gray-700 dark:border-gray-600">
        <summary className="cursor-pointer">Prompt</summary>
        <pre className="mt-2 whitespace-pre-wrap">{run.prompt}</pre>
      </details>
      <Terminal runId={run.id} interactive={interactive} />
    </div>
  );
}
