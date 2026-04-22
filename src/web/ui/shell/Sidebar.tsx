import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '../cn.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { sidebarRegistry, type SidebarView } from './sidebarRegistry.js';
import { SidebarUsage } from '../../features/usage/SidebarUsage.js';

export interface SidebarProject {
  id: number;
  name: string;
  runs: number;
  hasRunning: boolean;
  hasWaiting: boolean;
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
          title={collapsed ? p.name : undefined}
          className={({ isActive }) => cn(
            'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[14px] transition-colors duration-fast ease-out',
            collapsed && 'justify-center',
            isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
          )}
        >
          {collapsed ? (
            <span className="w-7 h-7 flex items-center justify-center rounded-md text-base font-semibold">
              {p.name[0]?.toUpperCase() ?? '·'}
            </span>
          ) : (
            <>
              {p.hasWaiting ? <StatusDot tone="attn" aria-label="waiting for input" />
               : p.hasRunning ? <StatusDot tone="run" aria-label="running" />
               : null}
              <span className="truncate">{p.name}</span>
              <span className="ml-auto font-mono text-[12px] text-text-faint">{p.runs}</span>
            </>
          )}
        </NavLink>
      ))}
      {!collapsed && <Group label="Views" />}
      {views.map((v) => (
        <NavLink
          key={v.id}
          to={v.route}
          title={collapsed ? v.label : undefined}
          className={({ isActive }) => cn(
            'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[14px] transition-colors duration-fast ease-out',
            collapsed && 'justify-center',
            isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
          )}
        >
          {collapsed ? (
            <span className="w-7 h-7 flex items-center justify-center rounded-md text-base font-semibold">
              {v.label[0]?.toUpperCase() ?? '·'}
            </span>
          ) : (
            <span className="truncate">{v.label}</span>
          )}
        </NavLink>
      ))}
      <div className="mt-auto">
        <SidebarUsage collapsed={collapsed} />
      </div>
    </div>
  );
}

function Group({ label }: { label: string }) {
  return <div className="px-3 pt-3 pb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">{label}</div>;
}
