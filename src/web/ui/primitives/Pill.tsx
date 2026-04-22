import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type PillTone = 'ok' | 'run' | 'fail' | 'warn' | 'wait';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone: PillTone;
}

const TONES: Record<PillTone, string> = {
  ok: 'bg-ok-subtle text-ok border-ok/40',
  run: 'bg-run-subtle text-run border-run/40 animate-pulse',
  fail: 'bg-fail-subtle text-fail border-fail/40',
  warn: 'bg-warn-subtle text-warn border-warn/40',
  wait: 'bg-surface-raised text-text-dim border-border-strong',
};

export function Pill({ tone, className, ...rest }: PillProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[11px] font-medium px-1.5 rounded-sm border',
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}
