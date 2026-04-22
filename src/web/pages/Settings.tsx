import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { ChipInput } from '../components/ChipInput.js';
import { McpServerList } from '../components/McpServerList.js';

export function SettingsPage() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [marketplaces, setMarketplaces] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setPrompt(s.global_prompt);
      setEnabled(s.notifications_enabled);
      setMarketplaces(s.global_marketplaces);
      setPlugins(s.global_plugins);
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (prompt == null) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.updateSettings({
        global_prompt: prompt,
        notifications_enabled: enabled,
        global_marketplaces: marketplaces,
        global_plugins: plugins,
      });
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  if (prompt == null) return <div>Loading…</div>;

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <label className="block">
        <span className="block text-sm font-medium mb-1">Global prompt</span>
        <span className="block text-xs text-gray-500 dark:text-gray-400 mb-2">
          Prepended to every run across every project, before project instructions.
        </span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={10}
          className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="text-sm">Enable run-completion notifications</span>
      </label>

      <hr className="dark:border-gray-700" />

      <div className="space-y-4">
        <div>
          <h2 className="text-base font-semibold mb-0.5">Tools</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">Available in every run across all projects.</p>
        </div>

        <ChipInput
          label="Plugin marketplaces"
          values={marketplaces}
          onChange={setMarketplaces}
          placeholder="https://registry.example.com"
        />

        <ChipInput
          label="Plugins"
          values={plugins}
          onChange={setPlugins}
          placeholder="name@marketplace"
        />

        <div>
          <McpServerList projectId={null} label="MCP servers" />
        </div>
      </div>

      {error && <div className="text-red-600 text-sm">{error}</div>}
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
