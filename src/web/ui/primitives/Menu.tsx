import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn.js';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  trigger: ReactNode;
  items: readonly MenuItem[];
}

export function Menu({ trigger, items }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 z-[var(--z-palette)] min-w-[160px] bg-surface-raised border border-border-strong rounded-md shadow-popover py-1"
        >
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onSelect(); }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-sm transition-colors duration-fast ease-out',
                it.danger ? 'text-fail hover:bg-fail-subtle' : 'text-text hover:bg-surface',
                it.disabled && 'opacity-50 cursor-not-allowed',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
