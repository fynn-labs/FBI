import type { ReactNode } from 'react';
import { Kbd } from '../primitives/Kbd.js';

export interface TopbarProps {
  breadcrumb: ReactNode;
  onOpenPalette: () => void;
}

export function Topbar({ breadcrumb, onOpenPalette }: TopbarProps) {
  return (
    <header className="h-[32px] flex items-center gap-3 px-3 border-b border-border-strong bg-surface">
      <span className="font-semibold text-[15px] tracking-tight">▮ FBI</span>
      <span className="font-mono text-[13px] text-text-faint truncate">{breadcrumb}</span>
      <button
        type="button"
        onClick={onOpenPalette}
        className="ml-auto flex items-center gap-1 text-[13px] text-text-faint hover:text-text"
        aria-label="Open command palette"
      >
        <Kbd>⌘</Kbd><Kbd>K</Kbd><span>search</span>
      </button>
    </header>
  );
}
