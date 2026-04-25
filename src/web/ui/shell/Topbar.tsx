import { type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Kbd } from '../primitives/Kbd.js';

export interface TopbarProps {
  breadcrumb: ReactNode;
  onOpenPalette: () => void;
}

function TrafficLights() {
  const win = getCurrentWindow();
  return (
    <div className="group flex items-center gap-[6px] shrink-0">
      <button
        type="button"
        onClick={() => void win.close()}
        className="w-3 h-3 rounded-full flex items-center justify-center bg-[var(--traffic-red)] hover:brightness-110 focus-visible:outline-none"
        aria-label="Close window"
      >
        <span className="opacity-0 group-hover:opacity-100 text-[7px] text-black/50 font-bold leading-none select-none">×</span>
      </button>
      <button
        type="button"
        onClick={() => void win.minimize()}
        className="w-3 h-3 rounded-full flex items-center justify-center bg-[var(--traffic-yellow)] hover:brightness-110 focus-visible:outline-none"
        aria-label="Minimize window"
      >
        <span className="opacity-0 group-hover:opacity-100 text-[7px] text-black/50 font-bold leading-none select-none">−</span>
      </button>
      <button
        type="button"
        onClick={() => void win.toggleMaximize()}
        className="w-3 h-3 rounded-full flex items-center justify-center bg-[var(--traffic-green)] hover:brightness-110 focus-visible:outline-none"
        aria-label="Maximize window"
      >
        <span className="opacity-0 group-hover:opacity-100 text-[7px] text-black/50 font-bold leading-none select-none">+</span>
      </button>
    </div>
  );
}

export function Topbar({ breadcrumb, onOpenPalette }: TopbarProps) {
  const inTauri = isTauri();
  const dragProps = inTauri ? { 'data-tauri-drag-region': '' } : {};
  return (
    <header
      className="h-[36px] flex items-center gap-2 px-3 border-b border-border-strong bg-surface"
      {...dragProps}
    >
      {inTauri && <TrafficLights />}
      {inTauri && <div className="w-px h-[14px] bg-border-strong shrink-0" />}
      <span className="font-semibold text-[15px] tracking-tight shrink-0">▮ FBI</span>
      <span className="font-mono text-[13px] text-text-faint truncate">{breadcrumb}</span>
      <button
        type="button"
        onClick={onOpenPalette}
        className="ml-auto flex items-center gap-1 text-[13px] text-text-faint hover:text-text shrink-0"
        aria-label="Open command palette"
      >
        <Kbd>⌘</Kbd><Kbd>K</Kbd><span>search</span>
      </button>
    </header>
  );
}
