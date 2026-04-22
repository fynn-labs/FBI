import { useRateLimit } from '../../hooks/useRateLimit.js';

function formatReset(s: number | null): string | null {
  if (s == null || s <= 0) return null;
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export function UsageWarning() {
  const rl = useRateLimit();
  if (!rl || rl.percent_used == null || rl.percent_used < 0.9) return null;
  const pct = Math.round(rl.percent_used * 100);
  const reset = formatReset(rl.reset_in_seconds);
  return (
    <div role="alert" className="p-3 border border-warn bg-warn-subtle text-warn rounded-md text-[14px] font-mono">
      ⚠ Claude usage {pct}% of the 5-hour window{reset ? ` · resets in ${reset}` : ''}. Starting a new run is allowed but may hit the limit.
    </div>
  );
}
