import { useEffect, useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { LoadingState, EmptyState } from '@ui/patterns/index.js';
import { Button } from '@ui/primitives/Button.js';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { ProjectList } from '../features/projects/ProjectList.js';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const location = useLocation();
  const atIndex = location.pathname.replace(/\/$/, '') === '/projects';

  useEffect(() => {
    void api.listProjects().then(setProjects);
    void api.listRuns().then(setRuns);
  }, []);

  if (!projects) return <LoadingState label="Loading projects…" />;

  return (
    <SplitPane
      leftWidth="320px"
      storageKey="projects"
      left={
        <div className="flex flex-col h-full">
          <ProjectList projects={projects} runs={runs} />
          {projects.length === 0 && (
            <div className="p-4"><EmptyState title="No projects yet" action={<Link to="/projects/new"><Button>Create project</Button></Link>} /></div>
          )}
        </div>
      }
      right={
        atIndex ? (
          <div className="h-full flex items-center justify-center">
            <EmptyState title="Select a project" description="Pick a project, or create one." />
          </div>
        ) : <Outlet />
      }
    />
  );
}
