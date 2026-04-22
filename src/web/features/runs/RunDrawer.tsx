import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';

export type RunTab = 'files' | 'prompt' | 'github';

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  filesCount: number;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({ open, onToggle, filesCount, children }: RunDrawerProps) {
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
          ]}
        />
      }
    >
      <div className="max-h-[35vh] overflow-auto">{children(tab)}</div>
    </Drawer>
  );
}
