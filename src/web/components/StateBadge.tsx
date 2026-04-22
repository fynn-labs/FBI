import type { RunState } from '@shared/types.js';

const COLORS: Record<RunState, string> = {
  queued: 'bg-gray-200 text-gray-800',
  running: 'bg-blue-200 text-blue-800',
  succeeded: 'bg-green-200 text-green-800',
  failed: 'bg-red-200 text-red-800',
  cancelled: 'bg-yellow-200 text-yellow-800',
};

export function StateBadge({ state }: { state: RunState }) {
  return (
    <span className={`inline-block px-2 py-1 rounded text-xs font-mono ${COLORS[state]}`}>
      {state}
    </span>
  );
}
