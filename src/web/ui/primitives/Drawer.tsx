import type { ReactNode } from 'react';
import { cn } from '../cn.js';
import { IconButton } from './IconButton.js';

export interface DrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  header: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Drawer({ open, onToggle, header, children, className }: DrawerProps) {
  return (
    <div className={cn('border-t border-border-strong bg-surface', className)}>
      <div className="flex items-center px-3 py-1.5">
        <div className="flex-1 min-w-0 font-mono text-[11px] text-text-dim">{header}</div>
        <IconButton
          aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
          onClick={() => onToggle(!open)}
          className="text-[12px]"
        >
          {open ? '▾' : '▸'}
        </IconButton>
      </div>
      {open && <div className="border-t border-border">{children}</div>}
    </div>
  );
}
