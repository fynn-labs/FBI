import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RunsFilter } from './RunsFilter.js';
import { RunRow } from './RunRow.js';
import { useRunsView, applyRunsView } from './useRunsView.js';
import type { StateCounts } from './StateFilterButton.js';
import type { Run, RunState } from '@shared/types.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';

export interface RunsListProps {
  runs: readonly Run[];
  toHref: (r: Run) => string;
  currentId?: number | null;
}

const TONE_TEXT: Record<RunState, string> = {
  running: 'text-run',
  waiting: 'text-attn',
  awaiting_resume: 'text-warn',
  queued: 'text-text-faint',
  succeeded: 'text-ok',
  failed: 'text-fail',
  cancelled: 'text-text-faint',
};

export function RunsList({ runs, toHref, currentId }: RunsListProps) {
  const [filter, setFilter] = useState('');
  const view = useRunsView();
  const nav = useNavigate();

  const textFiltered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return runs;
    return runs.filter((r) =>
      String(r.id).includes(q) ||
      (r.title ?? '').toLowerCase().includes(q) ||
      (r.branch_name ?? '').toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q),
    );
  }, [runs, filter]);

  const counts: StateCounts = useMemo(() => {
    const base: StateCounts = {
      running: 0, waiting: 0, awaiting_resume: 0, queued: 0,
      succeeded: 0, failed: 0, cancelled: 0,
    };
    for (const r of textFiltered) base[r.state]++;
    return base;
  }, [textFiltered]);

  const result = useMemo(
    () => applyRunsView(textFiltered, { filter: view.filter, groupByState: view.groupByState }),
    [textFiltered, view.filter, view.groupByState],
  );

  // Flatten for keyboard navigation so j/k walks the same order the user sees.
  const flatForNav: readonly Run[] = useMemo(() => {
    if (result.mode === 'flat') return [...result.active, ...result.rest];
    return result.groups.flatMap((g) => g.runs);
  }, [result]);

  const stateRef = useRef({ flatForNav, currentId, toHref, nav });
  stateRef.current = { flatForNav, currentId, toHref, nav };

  function step(dir: 1 | -1): void {
    const { flatForNav: list, currentId: cur, toHref: href, nav: n } = stateRef.current;
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
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Runs</h2>
        <span className="font-mono text-[12px] text-text-faint">{runs.length} · {running} running</span>
      </div>
      <RunsFilter value={filter} onChange={setFilter} view={view} counts={counts} />
      <div className="flex-1 min-h-0 overflow-auto">
        {result.mode === 'flat' ? (
          <>
            {result.active.length > 0 && (
              <div className="px-3 py-1 text-[11px] uppercase tracking-[0.08em] text-text-faint border-b border-border">
                Active · {result.active.length}
              </div>
            )}
            {result.active.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
            {result.rest.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
          </>
        ) : (
          result.groups.map((g) => (
            <div key={g.state}>
              <div
                data-testid="runs-group-label"
                className={`px-3 py-1 text-[11px] uppercase tracking-[0.08em] border-b border-border bg-surface ${TONE_TEXT[g.state]}`}
              >
                {g.state} · {g.runs.length}
              </div>
              {g.runs.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
