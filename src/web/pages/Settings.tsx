import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';

export function SettingsPage() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [warnAt, setWarnAt] = useState<number>(0);
  const [gcEnabled, setGcEnabled] = useState<boolean>(false);
  const [lastGc, setLastGc] = useState<{ at: number | null; count: number | null; bytes: number | null }>({ at: null, count: null, bytes: null });
  const [runningGc, setRunningGc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setPrompt(s.global_prompt);
      setEnabled(s.notifications_enabled);
      setWarnAt(s.concurrency_warn_at);
      setGcEnabled(s.image_gc_enabled);
      setLastGc({ at: s.last_gc_at, count: s.last_gc_count, bytes: s.last_gc_bytes });
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (prompt == null) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.updateSettings({ global_prompt: prompt, notifications_enabled: enabled, concurrency_warn_at: warnAt, image_gc_enabled: gcEnabled });
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
      <label className="block">
        <span className="block text-sm font-medium mb-1">
          Warn when starting a run with this many already in flight (0 = never warn)
        </span>
        <input type="number" min={0} value={warnAt}
          onChange={(e) => setWarnAt(Number(e.target.value))}
          className="w-32 border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100" />
      </label>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={gcEnabled}
          onChange={(e) => setGcEnabled(e.target.checked)} />
        <span className="text-sm">Enable nightly image GC (keeps images used in the last 30 days)</span>
      </label>

      <div className="flex items-center gap-3">
        <button type="button" disabled={!gcEnabled || runningGc}
          onClick={async () => {
            setRunningGc(true);
            try {
              const res = await api.runGc();
              setLastGc({ at: Date.now(), count: res.deletedCount, bytes: res.deletedBytes });
            } finally { setRunningGc(false); }
          }}
          className="border rounded px-3 py-1 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200">
          {runningGc ? 'Running…' : 'Run GC now'}
        </button>
        {lastGc.at && (
          <span className="text-xs text-gray-500">
            Last: {new Date(lastGc.at).toLocaleString()} — {lastGc.count ?? 0} images, {Math.round((lastGc.bytes ?? 0) / 1e6)} MB
          </span>
        )}
      </div>

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
