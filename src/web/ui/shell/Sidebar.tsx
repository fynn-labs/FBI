import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '../cn.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { sidebarRegistry, type SidebarView } from './sidebarRegistry.js';

export interface SidebarProject {
  id: number;
  name: string;
  runs: number;
  hasRunning: boolean;
}

export interface SidebarProps {
  projects: readonly SidebarProject[];
  collapsed?: boolean;
  onCreateProject?: () => void;
}

export function Sidebar({ projects, collapsed }: SidebarProps) {
  const [views, setViews] = useState<readonly SidebarView[]>([]);
  useEffect(() => {
    const update = () => setViews(sidebarRegistry.list());
    update();
    return sidebarRegistry.subscribe(update);
  }, []);

  return (
    <div className={cn('h-full flex flex-col bg-surface border-r border-border-strong transition-all duration-base ease-out', collapsed ? 'w-[52px]' : 'w-[220px]')}>
      {!collapsed && <Group label="Projects" />}
      {projects.map((p) => (
        <NavLink
          key={p.id}
          to={`/projects/${p.id}`}
          className={({ isActive }) => cn(
            'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[13px] transition-colors duration-fast ease-out',
            isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
          )}
        >
          {p.hasRunning && <StatusDot tone="run" aria-label="running" />}
          <span className="truncate">{collapsed ? p.name.slice(0, 2) : p.name}</span>
          {!collapsed && <span className="ml-auto font-mono text-[11px] text-text-faint">{p.runs}</span>}
        </NavLink>
      ))}
      {!collapsed && <Group label="Views" />}
      {views.map((v) => (
        <NavLink
          key={v.id}
          to={v.route}
          className={({ isActive }) => cn(
            'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[13px] transition-colors duration-fast ease-out',
            isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
          )}
        >
          <span className="truncate">{collapsed ? v.label.slice(0, 2) : v.label}</span>
        </NavLink>
      ))}
    </div>
  );
}

function Group({ label }: { label: string }) {
  return <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-faint">{label}</div>;
}
