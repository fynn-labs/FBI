import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { ProjectsPage } from './pages/Projects.js';
import { NewProjectPage } from './pages/NewProject.js';
import { ProjectDetailPage } from './pages/ProjectDetail.js';
import { EditProjectPage } from './pages/EditProject.js';
import { NewRunPage } from './pages/NewRun.js';
import { RunsPage } from './pages/Runs.js';
import { RunDetailPage } from './pages/RunDetail.js';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/edit" element={<EditProjectPage />} />
        <Route path="/projects/:id/runs/new" element={<NewRunPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
