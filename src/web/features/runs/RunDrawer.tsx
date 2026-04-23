import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';

export type RunTab = 'changes' | 'tunnel' | 'meta';

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  changesCount: number;
  portsCount: number | null;
  height: number;
  onHeightChange: (h: number) => void;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({
  open, onToggle, changesCount, portsCount, height, onHeightChange, children,
}: RunDrawerProps) {
  const [tab, setTab] = useState<RunTab>('changes');
  const pickTab = (next: RunTab): void => {
    setTab(next);
    if (!open) onToggle(true);
  };
  return (
    <Drawer
      open={open}
      onToggle={onToggle}
      height={height}
      onHeightChange={onHeightChange}
      header={
        <Tabs
          value={tab}
          onChange={pickTab}
          tabs={[
            { value: 'changes', label: 'changes', count: changesCount },
            { value: 'tunnel', label: 'tunnel', count: portsCount ?? undefined },
            { value: 'meta', label: 'meta' },
          ]}
        />
      }
    >
      <div className="h-full overflow-auto">{children(tab)}</div>
    </Drawer>
  );
}
