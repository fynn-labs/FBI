import type { ReactNode } from 'react';
import { cn } from '../cn.js';

export interface DrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  header: ReactNode;
  children?: ReactNode;
  className?: string;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={cn('transition-transform duration-fast ease-out', open ? 'rotate-0' : 'rotate-180')}
    >
      <path d="M3 4.5 L6 7.5 L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Drawer({ open, onToggle, header, children, className }: DrawerProps) {
  return (
    <div className={cn('border-t border-border-strong bg-surface', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
        onClick={() => onToggle(!open)}
        className="w-full flex items-center px-3 py-1.5 text-left hover:bg-surface-raised transition-colors duration-fast ease-out"
      >
        <div className="flex-1 min-w-0 font-mono text-[13px] text-text-dim">{header}</div>
        <span className="text-text-faint ml-2">
          <Chevron open={open} />
        </span>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}
