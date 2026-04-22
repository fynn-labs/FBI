import { useEffect, useState } from 'react';
import type { SecretName } from '@shared/types.js';
import { api } from '../lib/api.js';

export function SecretsEditor({ projectId }: { projectId: number }) {
  const [names, setNames] = useState<SecretName[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setNames(await api.listSecrets(projectId));
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function add() {
    if (!name) return;
    try {
      await api.upsertSecret(projectId, name, value);
      setName(''); setValue('');
      await refresh();
      setError(null);
    } catch (e) { setError(String(e)); }
  }
  async function remove(n: string) {
    try {
      await api.removeSecret(projectId, n);
      await refresh();
      setError(null);
    } catch (e) { setError(String(e)); }
  }
  return (
    <section className="bg-white border rounded p-4">
      <h2 className="font-semibold mb-2">Secrets</h2>
      <ul className="mb-3 space-y-1">
        {names.length === 0 && <li className="text-gray-500">None</li>}
        {names.map((s) => (
          <li key={s.name} className="flex justify-between items-center">
            <code>{s.name}</code>
            <button onClick={() => remove(s.name)} className="text-red-600 text-sm">
              remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          placeholder="NAME" value={name} onChange={(e) => setName(e.target.value)}
          className="border rounded px-2 py-1 font-mono"
        />
        <input
          placeholder="value" value={value} onChange={(e) => setValue(e.target.value)}
          type="password"
          className="border rounded px-2 py-1 flex-1"
        />
        <button onClick={add} className="bg-gray-800 text-white px-3 py-1 rounded">
          Add
        </button>
      </div>
      {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
    </section>
  );
}
