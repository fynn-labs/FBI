import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';

export function SettingsPage() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => setPrompt(s.global_prompt));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (prompt == null) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.updateSettings({ global_prompt: prompt });
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  if (prompt == null) return <div>Loading…</div>;

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <label className="block">
        <span className="block text-sm font-medium mb-1">Global prompt</span>
        <span className="block text-xs text-gray-500 mb-2">
          Prepended to every run across every project, before project instructions.
        </span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={10}
          className="w-full border rounded px-2 py-1 font-mono text-sm"
        />
      </label>
      {error && <div className="text-red-600">{error}</div>}
      {saved && <div className="text-green-600 text-sm">Saved.</div>}
      <button
        type="submit"
        disabled={saving}
        className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
