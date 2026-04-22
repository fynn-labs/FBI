import { useRateLimit } from '../../hooks/useRateLimit.js';

function formatReset(s: number | null): string | null {
  if (s == null || s <= 0) return null;
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

export function RateLimitPill() {
  const rl = useRateLimit();
  if (!rl || rl.percent_used == null) {
    return <span className="text-text-faint">Claude —</span>;
  }
  const pct = Math.round(rl.percent_used * 100);
  const reset = formatReset(rl.reset_in_seconds);
  const tone = rl.percent_used >= 0.9 ? 'text-fail' : rl.percent_used >= 0.75 ? 'text-warn' : 'text-ok';
  return (
    <span>
      Claude <span className={tone}>{pct}%</span>{reset ? <> · {reset}</> : null}
    </span>
  );
}
