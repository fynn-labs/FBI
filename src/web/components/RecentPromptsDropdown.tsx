import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

interface Props {
  projectId: number;
  onPick: (prompt: string) => void;
}

export function RecentPromptsDropdown({ projectId, onPick }: Props) {
  const [items, setItems] = useState<
    { prompt: string; last_used_at: number; run_id: number }[]
  >([]);

  useEffect(() => {
    let alive = true;
    void api.getRecentPrompts(projectId, 10).then((xs) => {
      if (alive) setItems(xs);
    });
    return () => { alive = false; };
  }, [projectId]);

  if (items.length === 0) return null;

  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">Recent prompts</span>
      <select
        className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        defaultValue=""
        onChange={(e) => {
          const idx = Number(e.target.value);
          if (Number.isFinite(idx) && items[idx]) {
            onPick(items[idx].prompt);
            e.currentTarget.value = '';
          }
        }}
      >
        <option value="" disabled>Load a previous prompt…</option>
        {items.map((it, idx) => (
          <option key={it.run_id} value={idx}>
            {it.prompt.slice(0, 80).replace(/\s+/g, ' ')}
            {it.prompt.length > 80 ? '…' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
