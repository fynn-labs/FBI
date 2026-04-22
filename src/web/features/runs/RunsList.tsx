import { useMemo, useState } from 'react';
import { RunsFilter } from './RunsFilter.js';
import { RunRow } from './RunRow.js';
import type { Run } from '@shared/types.js';

export interface RunsListProps {
  runs: readonly Run[];
  toHref: (r: Run) => string;
}

export function RunsList({ runs, toHref }: RunsListProps) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return runs;
    return runs.filter((r) =>
      String(r.id).includes(q) ||
      (r.branch_name ?? '').toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q),
    );
  }, [runs, filter]);

  const running = runs.filter((r) => r.state === 'running').length;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-faint">
          Runs
        </h2>
        <span className="font-mono text-[11px] text-text-faint">
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
