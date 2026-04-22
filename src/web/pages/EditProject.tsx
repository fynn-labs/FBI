import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Project } from '@shared/types.js';
import { api } from '../lib/api.js';

export function EditProjectPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [p, setP] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void api.getProject(pid).then(setP); }, [pid]);
  if (!p) return <div>Loading…</div>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!p) return;
    try {
      await api.updateProject(pid, {
        name: p.name,
        repo_url: p.repo_url,
        default_branch: p.default_branch,
        instructions: p.instructions,
        devcontainer_override_json: p.devcontainer_override_json,
        git_author_name: p.git_author_name,
        git_author_email: p.git_author_email,
        marketplaces: p.marketplaces,
        plugins: p.plugins,
      });
      nav(`/projects/${pid}`);
    } catch (err) { setError(String(err)); }
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Edit {p.name}</h1>
      <Text label="Name" value={p.name} onChange={(v) => setP({ ...p, name: v })} />
      <Text label="Repo URL" value={p.repo_url} onChange={(v) => setP({ ...p, repo_url: v })} />
      <Text label="Default branch" value={p.default_branch} onChange={(v) => setP({ ...p, default_branch: v })} />
      <Text label="Git author name (override)" value={p.git_author_name ?? ''} onChange={(v) => setP({ ...p, git_author_name: v || null })} />
      <Text label="Git author email (override)" value={p.git_author_email ?? ''} onChange={(v) => setP({ ...p, git_author_email: v || null })} />
      <Area label="Instructions" value={p.instructions ?? ''} onChange={(v) => setP({ ...p, instructions: v || null })} />
      <Area label="Extra plugin marketplaces (one per line; merged with global defaults)"
            value={p.marketplaces.join('\n')}
            onChange={(v) => setP({ ...p, marketplaces: splitLines(v) })} />
      <Area label="Extra plugins (one per line, format: name@marketplace)"
            value={p.plugins.join('\n')}
            onChange={(v) => setP({ ...p, plugins: splitLines(v) })} />
      <Area label="Devcontainer override JSON (used when repo has no .devcontainer/devcontainer.json)"
            value={p.devcontainer_override_json ?? ''}
            onChange={(v) => setP({ ...p, devcontainer_override_json: v || null })} />
      {error && <div className="text-red-600">{error}</div>}
      <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">Save</button>
    </form>
  );
}

function splitLines(v: string): string[] {
  return v.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)}
             className="w-full border rounded px-2 py-1 font-mono dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100" />
    </label>
  );
}
function Area({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={5}
                className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100" />
    </label>
  );
}
