import { useEffect, useState } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { LoadingState, EmptyState } from '@ui/patterns/index.js';
import { Button } from '@ui/primitives/Button.js';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { ProjectList } from '../features/projects/ProjectList.js';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(() => {
    void api.listProjects().then(setProjects);
    void api.listRuns().then(setRuns);
  }, []);

  if (!projects) return <LoadingState label="Loading projects…" />;

  return (
    <SplitPane
      leftWidth="320px"
      left={
        <div className="flex flex-col h-full">
          <ProjectList projects={projects} runs={runs} />
          {projects.length === 0 && (
            <div className="p-4"><EmptyState title="No projects yet" action={<Link to="/projects/new"><Button>Create project</Button></Link>} /></div>
          )}
        </div>
      }
      right={<Outlet />}
    />
  );
}
