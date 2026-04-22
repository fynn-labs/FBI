import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

export function NewProjectPage() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const p = await api.createProject({
        name,
        repo_url: repoUrl,
        default_branch: defaultBranch,
        instructions: instructions.trim() || null,
        devcontainer_override_json: null,
        git_author_name: null,
        git_author_email: null,
      });
      nav(`/projects/${p.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold">New Project</h1>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full border rounded px-2 py-1"
        />
      </Field>
      <Field label="Repo URL (SSH)">
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          required
          className="w-full border rounded px-2 py-1 font-mono"
        />
      </Field>
      <Field label="Default Branch">
        <input
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          required
          className="w-full border rounded px-2 py-1"
        />
      </Field>
      <Field label="Project-level instructions (optional)">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={4}
          className="w-full border rounded px-2 py-1 font-mono text-sm"
        />
      </Field>
      {error && <div className="text-red-600">{error}</div>}
      <button type="submit" disabled={submitting} className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50">
        {submitting ? 'Creating…' : 'Create'}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
    </label>
  );
}
