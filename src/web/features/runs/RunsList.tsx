import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RunsFilter } from './RunsFilter.js';
import { RunRow } from './RunRow.js';
import type { Run } from '@shared/types.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';

export interface RunsListProps {
  runs: readonly Run[];
  toHref: (r: Run) => string;
  currentId?: number | null;
}

export function RunsList({ runs, toHref, currentId }: RunsListProps) {
  const [filter, setFilter] = useState('');
  const nav = useNavigate();
  const visible = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return runs;
    return runs.filter((r) =>
      String(r.id).includes(q) ||
      (r.title ?? '').toLowerCase().includes(q) ||
      (r.branch_name ?? '').toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q),
    );
  }, [runs, filter]);

  // Keep a ref with the latest list + current id so the j/k handlers (registered once)
  // always see fresh data without re-registering the keymap on every list update.
  const stateRef = useRef({ visible, currentId, toHref, nav });
  stateRef.current = { visible, currentId, toHref, nav };

  function step(dir: 1 | -1): void {
    const { visible: list, currentId: cur, toHref: href, nav: n } = stateRef.current;
    if (list.length === 0) return;
    const idx = cur == null ? -1 : list.findIndex((r) => r.id === cur);
    const nextIdx = idx < 0 ? (dir === 1 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
    n(href(list[nextIdx]));
  }

  useKeyBinding({ chord: 'j', handler: () => step(1), description: 'Next run' }, []);
  useKeyBinding({ chord: 'k', handler: () => step(-1), description: 'Previous run' }, []);

  const running = runs.filter((r) => r.state === 'running').length;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">
          Runs
        </h2>
        <span className="font-mono text-[12px] text-text-faint">
          {runs.length} · {running} running
        </span>
      </div>
      <RunsFilter value={filter} onChange={setFilter} />
      <div className="flex-1 min-h-0 overflow-auto">
        {visible.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
      </div>
    </div>
  );
}
