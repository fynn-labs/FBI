import type { ReactNode } from 'react';
import { cn } from '../cn.js';

export interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  leftWidth?: string;
  className?: string;
}

export function SplitPane({ left, right, leftWidth = '360px', className }: SplitPaneProps) {
  return (
    <div className={cn('h-full min-h-0 flex', className)}>
      <aside
        className="shrink-0 border-r border-border-strong bg-surface min-h-0 overflow-auto"
        style={{ width: leftWidth }}
      >
        {left}
      </aside>
      <main className="flex-1 min-w-0 min-h-0 overflow-auto">{right}</main>
    </div>
  );
}
