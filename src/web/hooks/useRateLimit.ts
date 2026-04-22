import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { RateLimitState } from '@shared/types.js';

export function useRateLimit(intervalMs = 30_000): RateLimitState | null {
  const [state, setState] = useState<RateLimitState | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => {
      api.getRateLimit()
        .then((s) => { if (!stop) setState(s); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => { stop = true; clearInterval(t); };
  }, [intervalMs]);
  return state;
}
