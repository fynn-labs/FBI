// src/web/pages/NewProject.tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { JsonEditor } from '../components/JsonEditor.js';

function splitLines(v: string): string[] {
  return v.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function NewProjectPage() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');
  const [instructions, setInstructions] = useState('');
  const [marketplaces, setMarketplaces] = useState('');
  const [plugins, setPlugins] = useState('');
  const [devcontainerJson, setDevcontainerJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const p = await api.createProject({
        name,
        repo_url: repoUrl,
        default_branch: defaultBranch,
        instructions: instructions.trim() || null,
        devcontainer_override_json: devcontainerJson.trim() || null,
        git_author_name: gitAuthorName.trim() || null,
        git_author_email: gitAuthorEmail.trim() || null,
        marketplaces: splitLines(marketplaces),
        plugins: splitLines(plugins),
      });
      nav(`/projects/${p.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">New Project</h1>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Repo URL (SSH)">
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          required
          className="w-full border rounded px-2 py-1 font-mono dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Default Branch">
        <input
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          required
          className="w-full border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Git author name (override)">
        <input
          value={gitAuthorName}
          onChange={(e) => setGitAuthorName(e.target.value)}
          className="w-full border rounded px-2 py-1 font-mono dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Git author email (override)">
        <input
          value={gitAuthorEmail}
          onChange={(e) => setGitAuthorEmail(e.target.value)}
          className="w-full border rounded px-2 py-1 font-mono dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Project-level instructions (optional)">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={4}
          className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Extra plugin marketplaces (one per line; merged with global defaults)">
        <textarea
          value={marketplaces}
          onChange={(e) => setMarketplaces(e.target.value)}
          rows={3}
          className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Extra plugins (one per line, format: name@marketplace)">
        <textarea
          value={plugins}
          onChange={(e) => setPlugins(e.target.value)}
          rows={3}
          className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <JsonEditor
        label="Devcontainer override JSON (used when repo has no .devcontainer/devcontainer.json)"
        value={devcontainerJson}
        onChange={setDevcontainerJson}
      />
      {error && <div className="text-red-600">{error}</div>}
      <button
        type="submit"
        disabled={submitting}
        className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
      >
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
