import { Link } from 'react-router-dom';
import type { ChangesPayload } from '@shared/types.js';

export interface SubRunsSectionProps {
  children: ChangesPayload['children'];
}

export function SubRunsSection({ children }: SubRunsSectionProps) {
  if (children.length === 0) return null;
  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">Sub-runs</h3>
      <div className="space-y-1">
        {children.map((c) => (
          <Link key={c.id} to={`/runs/${c.id}`}
            className="flex items-center gap-2 px-2 py-1 text-[12px] text-text-dim hover:text-text hover:bg-surface-raised rounded-md">
            <span className="text-text-faint">↳</span>
            <span className="font-mono">#{c.id}</span>
            <span className="text-text-faint">{c.kind}</span>
            <span className="text-text-faint">·</span>
            <span>{c.state}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
