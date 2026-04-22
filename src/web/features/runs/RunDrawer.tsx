import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';

export type RunTab = 'files' | 'prompt' | 'github' | 'tunnel';

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  filesCount: number;
  portsCount: number | null;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({ open, onToggle, filesCount, portsCount, children }: RunDrawerProps) {
  const [tab, setTab] = useState<RunTab>('files');
  const pickTab = (next: RunTab) => {
    setTab(next);
    if (!open) onToggle(true);
  };
  return (
    <Drawer
      open={open}
      onToggle={onToggle}
      header={
        <Tabs
          value={tab}
          onChange={pickTab}
          tabs={[
            { value: 'files', label: 'files', count: filesCount },
            { value: 'prompt', label: 'prompt' },
            { value: 'github', label: 'github' },
            { value: 'tunnel', label: 'tunnel', count: portsCount ?? undefined },
          ]}
        />
      }
    >
      <div className="max-h-[35vh] overflow-auto">{children(tab)}</div>
    </Drawer>
  );
}
