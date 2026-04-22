import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar, type SidebarProject } from './Sidebar.js';
import { Topbar } from './Topbar.js';
import { StatusBar } from './StatusBar.js';
import { CommandPalette } from './CommandPalette.js';
import { keymap } from './KeyMap.js';

export interface AppShellProps {
  projects: readonly SidebarProject[];
  children: ReactNode;
  hideSidebar?: boolean;
}

export function AppShell({ projects, children, hideSidebar }: AppShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const location = useLocation();

  const breadcrumb = useMemo(() => location.pathname, [location.pathname]);

  useEffect(() => {
    const offK = keymap.register({ chord: 'mod+k', description: 'Open command palette', handler: () => setPaletteOpen(true) });
    const offB = keymap.register({ chord: 'mod+b', description: 'Toggle sidebar', handler: () => setSidebarCollapsed((v) => !v) });
    return () => { offK(); offB(); };
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-bg text-text">
      <Topbar breadcrumb={breadcrumb} onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex-1 min-h-0 flex">
        {!hideSidebar && <Sidebar projects={projects} collapsed={sidebarCollapsed} />}
        <main className="flex-1 min-w-0 min-h-0 overflow-auto">{children}</main>
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
