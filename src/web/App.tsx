import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, Cheatsheet } from '@ui/shell/index.js';
import { sidebarRegistry } from '@ui/shell/sidebarRegistry.js';
import { paletteRegistry } from '@ui/shell/paletteRegistry.js';
import { statusRegistry } from '@ui/shell/statusRegistry.js';
import { keymap } from '@ui/shell/KeyMap.js';
import { toggleTheme } from '@ui/theme.js';
import { api } from './lib/api.js';
import { useRunWatcher } from './hooks/useRunWatcher.js';
import type { Project, Run } from '@shared/types.js';
import { ProjectsPage } from './pages/Projects.js';
import { NewProjectPage } from './pages/NewProject.js';
import { ProjectDetailPage } from './pages/ProjectDetail.js';
import { EditProjectPage } from './pages/EditProject.js';
import { NewRunPage } from './pages/NewRun.js';
import { RunsPage } from './pages/Runs.js';
import { RunDetailPage } from './pages/RunDetail.js';
import { SettingsPage } from './pages/Settings.js';
import { DesignPage } from './pages/Design.js';

function Shell({ projects, runs, children }: { projects: Project[]; runs: Run[]; children: ReactNode }) {
  const location = useLocation();
  const hideSidebar = location.pathname === '/design';

  const active = runs.filter((r) => r.state === 'running').length;
  const today = runs.filter((r) => Date.now() - new Date(r.created_at).getTime() < 86400_000).length;

  const projectRows = projects.map((p) => ({
    id: p.id,
    name: p.name,
    runs: runs.filter((r) => r.project_id === p.id).length,
    hasRunning: runs.some((r) => r.project_id === p.id && r.state === 'running'),
  }));

  return (
    <AppShell projects={projectRows} hideSidebar={hideSidebar}>
      {children}
      <StatusRegistrations active={active} today={today} />
    </AppShell>
  );
}

function StatusRegistrations({ active, today }: { active: number; today: number }) {
  useEffect(() => {
    const off1 = statusRegistry.register({ id: 'conn', side: 'left', order: 0, render: () => <>● <span className="text-ok">connected</span></> });
    const off2 = statusRegistry.register({ id: 'active', side: 'left', order: 1, render: () => <>{active} <span className="text-run">running</span></> });
    const off3 = statusRegistry.register({ id: 'today', side: 'left', order: 2, render: () => <>{today} today</> });
    return () => { off1(); off2(); off3(); };
  }, [active, today]);
  return null;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [notif, setNotif] = useState(false);
  const [cheatsheet, setCheatsheet] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => {});
  }, []);
  useEffect(() => {
    const reload = () => void api.listRuns().then(setRuns).catch(() => {});
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void api.getSettings().then((s) => setNotif(s.notifications_enabled));
  }, []);
  useRunWatcher(notif);

  const dataRef = useRef({ projects, runs });
  dataRef.current = { projects, runs };

  useEffect(() => {
    const offRuns = sidebarRegistry.register({ id: 'runs', group: 'views', label: 'All runs', route: '/runs', order: 10 });
    const offSet = sidebarRegistry.register({ id: 'settings', group: 'views', label: 'Settings', route: '/settings', order: 20 });

    const offActions = paletteRegistry.register({
      id: 'actions',
      label: 'Actions',
      items: () => [
        { id: 'new-project', label: 'New project', hint: 'c p', onSelect: () => nav('/projects/new') },
        { id: 'runs', label: 'Go to all runs', hint: 'g r', onSelect: () => nav('/runs') },
        { id: 'settings', label: 'Open settings', hint: 'g s', onSelect: () => nav('/settings') },
        { id: 'toggle-theme', label: 'Toggle theme', onSelect: () => toggleTheme() },
      ],
    });

    const offRunsGroup = paletteRegistry.register({
      id: 'runs',
      label: 'Runs',
      items: (q) => {
        const query = q.toLowerCase().trim();
        return dataRef.current.runs
          .filter((r) => !query || String(r.id).includes(query) || (r.branch_name ?? '').toLowerCase().includes(query) || r.prompt.toLowerCase().includes(query))
          .slice(0, 10)
          .map((r) => ({
            id: `run-${r.id}`,
            label: `#${r.id} ${r.branch_name || r.prompt.split('\n')[0] || 'untitled'}`,
            hint: r.state,
            onSelect: () => nav(`/runs/${r.id}`),
          }));
      },
    });

    const offProjGroup = paletteRegistry.register({
      id: 'projects',
      label: 'Projects',
      items: (q) => {
        const query = q.toLowerCase().trim();
        return dataRef.current.projects
          .filter((p) => !query || p.name.toLowerCase().includes(query) || p.repo_url.toLowerCase().includes(query))
          .map((p) => ({ id: `proj-${p.id}`, label: p.name, hint: p.repo_url, onSelect: () => nav(`/projects/${p.id}`) }));
      },
    });

    const offGR = keymap.register({ chord: 'g r', description: 'Go to runs', handler: () => nav('/runs') });
    const offGS = keymap.register({ chord: 'g s', description: 'Go to settings', handler: () => nav('/settings') });
    const offCP = keymap.register({ chord: 'c p', description: 'Create project', handler: () => nav('/projects/new') });
    const offHelp = keymap.register({ chord: '?', description: 'Show keyboard shortcuts', handler: () => setCheatsheet(true) });

    return () => { offRuns(); offSet(); offActions(); offRunsGroup(); offProjGroup(); offGR(); offGS(); offCP(); offHelp(); };
  }, [nav]);

  return (
    <>
      <Shell projects={projects} runs={runs}>
        <Routes>
          <Route path="/" element={<Navigate to="/runs" replace />} />
          <Route path="/projects" element={<ProjectsPage />}>
            <Route path="new" element={<NewProjectPage />} />
          </Route>
          <Route path="/projects/:id" element={<ProjectDetailPage />}>
            <Route path="runs/:rid" element={<RunDetailPage />} />
            <Route path="runs/new" element={<NewRunPage />} />
          </Route>
          <Route path="/projects/:id/edit" element={<EditProjectPage />} />
          <Route path="/runs" element={<RunsPage />}>
            <Route path=":id" element={<RunDetailPage />} />
          </Route>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/design" element={<DesignPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
      <Cheatsheet open={cheatsheet} onClose={() => setCheatsheet(false)} />
    </>
  );
}
