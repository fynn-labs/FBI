import { useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { RecentPromptsDropdown } from '../components/RecentPromptsDropdown.js';

export function NewRunPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState(searchParams.get('branch') ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!Number.isFinite(pid)) {
    return <div className="text-red-600">Invalid project ID.</div>;
  }

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
      <button type="submit" disabled={submitting} className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50">
        {submitting ? 'Starting…' : 'Start Run'}
      </button>
    </form>
  );
}
