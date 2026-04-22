import type { RunState } from '@shared/types.js';

const COLORS: Record<RunState, string> = {
  queued:          'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
  running:         'bg-blue-200 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  awaiting_resume: 'bg-orange-200 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  succeeded:       'bg-green-200 text-green-800 dark:bg-green-900 dark:text-green-200',
  failed:          'bg-red-200 text-red-800 dark:bg-red-900 dark:text-red-200',
  cancelled:       'bg-yellow-200 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
};

export function StateBadge({ state }: { state: RunState }) {
  return (
    <span className={`inline-block px-2 py-1 rounded text-xs font-mono ${COLORS[state] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
      {state}
    </span>
  );
}
