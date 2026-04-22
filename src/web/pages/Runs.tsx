import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Run, Project, RunState } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';

const PAGE_SIZE = 50;

export function RunsPage() {
  const [params, setParams] = useSearchParams();
  const state = (params.get('state') ?? '') as RunState | '';
  const projectId = params.get('project_id') ?? '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1));

  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [qDraft, setQDraft] = useState(q);

  useEffect(() => { void api.listProjects().then(setProjects); }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const r = await api.listRunsPaged({
        state: state || undefined,
        project_id: projectId ? Number(projectId) : undefined,
        q: q || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      if (!controller.signal.aborted) {
        setRuns(r.items); setTotal(r.total);
      }
    };
    void load();
    return () => controller.abort();
  }, [state, projectId, q, page]);

  useEffect(() => {
    const h = setTimeout(() => {
      if (qDraft !== q) updateParams({ q: qDraft || undefined, page: '1' });
    }, 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft]);

  function updateParams(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k); else next.set(k, v);
    }
    setParams(next);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Runs</h1>
      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-sm">State
          <select value={state} onChange={(e) => updateParams({ state: e.target.value || undefined, page: '1' })}
            className="ml-2 border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100">
            <option value="">All</option>
            <option value="queued">queued</option>
            <option value="running">running</option>
            <option value="succeeded">succeeded</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
        <label className="text-sm">Project
          <select value={projectId} onChange={(e) => updateParams({ project_id: e.target.value || undefined, page: '1' })}
            className="ml-2 border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100">
            <option value="">All</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm flex-1">Search
          <input value={qDraft} onChange={(e) => setQDraft(e.target.value)}
            placeholder="prompt text…"
            className="ml-2 w-full border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100" />
        </label>
      </div>

      <ul className="divide-y dark:divide-gray-700">
        {runs.map((r) => (
          <li key={r.id} className="py-2 flex items-center gap-3">
            <StateBadge state={r.state} />
            <Link to={`/runs/${r.id}`} className="text-blue-700 dark:text-blue-300">Run #{r.id}</Link>
            <span className="text-sm text-gray-500 truncate">{r.prompt}</span>
          </li>
        ))}
      </ul>

      {total === 0 && <p className="text-sm text-gray-500">No runs match.</p>}

      <div className="flex items-center gap-2 text-sm">
        <button disabled={page <= 1} onClick={() => updateParams({ page: String(page - 1) })}
          className="border rounded px-2 py-1 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200">←</button>
        <span>Page {page} of {pages}</span>
        <button disabled={page >= pages} onClick={() => updateParams({ page: String(page + 1) })}
          className="border rounded px-2 py-1 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200">→</button>
        <span className="text-gray-500 ml-auto">{total} total</span>
      </div>
    </div>
  );
}
