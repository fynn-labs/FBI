import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Run } from '@shared/types.js';
import type { Project } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';
import { Terminal } from '../components/Terminal.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';

export function RunDetailPage() {
  const { id } = useParams();
  const runId = Number(id);
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [gh, setGh] = useState<Awaited<ReturnType<typeof api.getRunGithub>> | null>(null);
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof api.getRunDiff>> | null>(null);
  const [creatingPr, setCreatingPr] = useState(false);
  const [siblings, setSiblings] = useState<Run[]>([]);
  const [project, setProject] = useState<Project | null>(null);

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

  useEffect(() => {
    if (!run || run.state !== 'succeeded') return;
    let alive = true;
    const load = async () => {
      try {
        const g = await api.getRunGithub(run.id);
        if (alive) setGh(g);
      } catch { /* ignore */ }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [run?.id, run?.state]);

  useEffect(() => {
    if (!run || run.state !== 'succeeded') return;
    void api.getRunDiff(run.id).then(setDiff).catch(() => {});
  }, [run?.id, run?.state]);

  useEffect(() => {
    if (!run) return;
    void api.getRunSiblings(run.id).then(setSiblings).catch(() => setSiblings([]));
  }, [run?.id]);

  useEffect(() => {
    if (!run) return;
    void api.getProject(run.project_id).then(setProject).catch(() => {});
  }, [run?.project_id]);

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
      {run.state === 'succeeded' && gh && (
        <div className="border rounded p-3 space-y-2 dark:border-gray-600">
          <h3 className="text-sm font-medium">GitHub status</h3>
          {!gh.github_available ? (
            <p className="text-xs text-gray-500">GitHub CLI not available or non-GitHub remote.</p>
          ) : (
            <>
              {gh.pr ? (
                <a href={gh.pr.url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-300 text-sm">
                  PR #{gh.pr.number} — {gh.pr.title} [{gh.pr.state}]
                </a>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">No PR yet.</span>
                  <button disabled={creatingPr}
                    onClick={async () => {
                      setCreatingPr(true);
                      try { await api.createRunPr(run.id); const g = await api.getRunGithub(run.id); setGh(g); }
                      catch (err) { alert(String(err)); }
                      finally { setCreatingPr(false); }
                    }}
                    className="border rounded px-2 py-1 text-sm dark:border-gray-600 dark:text-gray-200">
                    {creatingPr ? 'Creating…' : 'Create PR'}
                  </button>
                </div>
              )}
              {gh.checks ? (
                <p className="text-xs">
                  CI: <span className={
                    gh.checks.state === 'success' ? 'text-green-600' :
                    gh.checks.state === 'failure' ? 'text-red-600' : 'text-gray-500'
                  }>{gh.checks.state}</span> ({gh.checks.passed}/{gh.checks.total} passed, {gh.checks.failed} failed)
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
      {run.state === 'succeeded' && diff && diff.github_available && (
        <details className="border rounded dark:border-gray-600">
          <summary className="cursor-pointer px-3 py-2 text-sm select-none">
            Files changed ({diff.files.length})
          </summary>
          {diff.files.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-500">No files changed.</p>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-500"><th className="text-left px-2">Status</th><th className="text-left px-2">File</th><th className="text-right px-2">+</th><th className="text-right px-2">−</th></tr>
              </thead>
              <tbody>
                {diff.files.map((f) => {
                  const repo = project ? parseGitHubRepo(project.repo_url) : null;
                  const href = repo ? `https://github.com/${repo}/blob/${diff.head}/${f.filename}` : '#';
                  return (
                    <tr key={f.filename}>
                      <td className="px-2">{f.status[0].toUpperCase()}</td>
                      <td className="px-2"><a href={href} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-300">{f.filename}</a></td>
                      <td className="px-2 text-right text-green-600">{f.additions}</td>
                      <td className="px-2 text-right text-red-600">{f.deletions}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </details>
      )}
      {siblings.length > 0 && (
        <details className="border rounded dark:border-gray-600">
          <summary className="cursor-pointer px-3 py-2 text-sm select-none">
            Related runs ({siblings.length})
          </summary>
          <ul className="px-3 py-2 divide-y text-sm dark:divide-gray-700">
            {siblings.map((s) => {
              const repo = project ? parseGitHubRepo(project.repo_url) : null;
              const compareUrl = repo && s.branch_name && run!.branch_name
                ? `https://github.com/${repo}/compare/${run!.branch_name}...${s.branch_name}`
                : null;
              return (
                <li key={s.id} className="py-1 flex items-center gap-2">
                  <Link to={`/runs/${s.id}`} className="text-blue-600 dark:text-blue-300">Run #{s.id}</Link>
                  <StateBadge state={s.state} />
                  <span className="text-gray-500">{s.branch_name}</span>
                  {compareUrl && (
                    <a href={compareUrl} target="_blank" rel="noreferrer"
                       className="ml-auto border rounded px-2 py-0.5 text-xs dark:border-gray-600">
                      Diff vs this
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
