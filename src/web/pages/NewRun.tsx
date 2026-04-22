import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Project, Settings } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RecentPromptsDropdown } from '../components/RecentPromptsDropdown.js';
import { composePrompt } from '@shared/composePrompt.js';

export function NewRunPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState(searchParams.get('branch') ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defaults, setDefaults] = useState<{ defaultMarketplaces: string[]; defaultPlugins: string[] } | null>(null);

  useEffect(() => {
    void api.getProject(pid).then(setProject);
    void api.getSettings().then(setSettings);
    void api.getConfigDefaults().then(setDefaults);
  }, [pid]);

  if (!Number.isFinite(pid)) {
    return <div className="text-red-600">Invalid project ID.</div>;
  }

  const preamble = project ? [
    `You are working in /workspace on ${project.repo_url}.`,
    `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
    branch.trim()
      ? `Create or check out a branch named \`${branch.trim()}\`,`
      : `Create or check out a branch appropriately named for this task,`,
    'do your work there, and leave all commits on that branch.',
    '',
  ].join('\n') : '';

  const composed = project && settings ? composePrompt({
    preamble,
    globalPrompt: settings.global_prompt,
    instructions: project.instructions ?? '',
    runPrompt: prompt,
  }) : '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    try {
      const run = await api.createRun(pid, prompt, branch);
      nav(`/runs/${run.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">New Run</h1>
      <RecentPromptsDropdown projectId={pid} onPick={setPrompt} />
      <label className="block">
        <span className="block text-sm font-medium mb-1">Branch name (optional)</span>
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="leave blank to let Claude choose"
          className="w-full border rounded px-3 py-2 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={12}
        placeholder="Describe what Claude should do…"
        className="w-full border rounded px-3 py-2 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        autoFocus
      />
      {error && <div className="text-red-600">{error}</div>}
      <details className="border rounded dark:border-gray-600">
        <summary className="cursor-pointer px-3 py-2 text-sm select-none">
          Preview what Claude will receive
        </summary>
        <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 dark:text-gray-200 max-h-96 overflow-auto">
          {composed || '(loading…)'}
        </pre>
      </details>
      {project && defaults && (() => {
        const marketplaces = dedup([...defaults.defaultMarketplaces, ...project.marketplaces]);
        const plugins      = dedup([...defaults.defaultPlugins, ...project.plugins]);
        if (marketplaces.length + plugins.length === 0) return null;
        return (
          <div className="text-xs text-gray-600 dark:text-gray-400">
            <span className="font-medium">Effective plugins:</span>{' '}
            {plugins.length ? plugins.join(' · ') : '(none)'}
            {' '}<span className="text-gray-400">({marketplaces.length} marketplaces, {plugins.length} plugins)</span>
          </div>
        );
      })()}
      <button type="submit" disabled={submitting} className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50">
        {submitting ? 'Starting…' : 'Start Run'}
      </button>
    </form>
  );
}

function dedup<T>(xs: T[]): T[] { return [...new Set(xs)]; }
