import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { subscribeUsage } from './usageBus.js';
import type { RunUsageBreakdownRow, Run, UsageSnapshot } from '@shared/types.js';

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface RunUsageProps {
  run: Run;
}

export function RunUsage({ run }: RunUsageProps) {
  const [rows, setRows] = useState<RunUsageBreakdownRow[] | null>(null);
  const [live, setLive] = useState<{ input: number; output: number; cache_read: number; cache_create: number } | null>(null);

  useEffect(() => {
    let stop = false;
    api.getRunUsageBreakdown(run.id)
      .then((r) => { if (!stop) setRows(r); })
      .catch(() => {});
    return () => { stop = true; };
  }, [run.id]);

  useEffect(() => {
    return subscribeUsage((id, snap: UsageSnapshot) => {
      if (id !== run.id) return;
      setLive((prev) => ({
        input: (prev?.input ?? run.tokens_input) + snap.input_tokens,
        output: (prev?.output ?? run.tokens_output) + snap.output_tokens,
        cache_read: (prev?.cache_read ?? run.tokens_cache_read) + snap.cache_read_tokens,
        cache_create: (prev?.cache_create ?? run.tokens_cache_create) + snap.cache_create_tokens,
      }));
    });
  }, [run.id, run.tokens_input, run.tokens_output, run.tokens_cache_read, run.tokens_cache_create]);

  const totalTokens = live
    ? live.input + live.output + live.cache_read + live.cache_create
    : run.tokens_total;

  if (totalTokens === 0) return null;

  return (
    <section className="mb-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint pb-1 border-b border-border mb-1">Usage</h3>
      <div className="flex items-center gap-1 text-[11px] text-text-dim py-0.5">
        <span className="text-text-faint">total</span>
        <span className="ml-auto font-mono">{fmt(totalTokens)}</span>
      </div>
      {rows && rows.length > 0 && rows.map((r) => {
        const sum = r.input + r.output + r.cache_read + r.cache_create;
        return (
          <div key={r.model} className="flex items-center gap-1 text-[11px] text-text-dim py-0.5">
            <span className="text-text-faint truncate">{r.model}</span>
            <span className="ml-auto font-mono">{fmt(sum)}</span>
          </div>
        );
      })}
      {run.usage_parse_errors > 0 && (
        <p className="text-[10px] text-warn mt-1">{run.usage_parse_errors} line(s) unparseable</p>
      )}
    </section>
  );
}
