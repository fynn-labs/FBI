import { NavLink } from 'react-router-dom';
import { Pill, type PillTone } from '@ui/primitives/index.js';
import { TimestampRelative } from '@ui/data/TimestampRelative.js';
import type { Run } from '@shared/types.js';

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait',
  running: 'run',
  awaiting_resume: 'warn',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'warn',
};

export interface RunRowProps {
  run: Run;
  to: string;
}

export function RunRow({ run, to }: RunRowProps) {
  const label = run.branch_name || run.prompt.split('\n')[0] || 'untitled';
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-1.5 border-b border-border text-[13px] transition-colors duration-fast ease-out ${
          isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text'
        }`
      }
    >
      <span className="font-mono text-[12px] w-8 text-text-faint">#{run.id}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {run.tokens_total > 0 && (
        <span className="font-mono text-[11px] text-text-faint">{fmt(run.tokens_total)}</span>
      )}
      <Pill tone={TONE[run.state]}>{run.state}</Pill>
      <TimestampRelative iso={new Date(run.created_at).toISOString()} />
    </NavLink>
  );
}
