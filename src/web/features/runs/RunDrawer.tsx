import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';

export type RunTab = 'files' | 'github' | 'tunnel' | 'meta';

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  filesCount: number;
  portsCount: number | null;
  height: number;
  onHeightChange: (h: number) => void;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({
  open, onToggle, filesCount, portsCount, height, onHeightChange, children,
}: RunDrawerProps) {
  const [tab, setTab] = useState<RunTab>('files');
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
            { value: 'files', label: 'files', count: filesCount },
            { value: 'github', label: 'github' },
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
