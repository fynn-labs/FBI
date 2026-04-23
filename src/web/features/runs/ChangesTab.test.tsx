import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { ChangesTab } from './ChangesTab.js';
import type { ChangesPayload, Run, Project } from '@shared/types.js';

const run = { id: 1, state: 'running', branch_name: 'feat/x', project_id: 1, prompt: '', title: null } as unknown as Run;
const project = { id: 1, repo_url: 'git@github.com:me/foo.git', default_merge_strategy: 'squash' } as unknown as Project;
const base: ChangesPayload = {
  branch_name: 'feat/x', branch_base: { base: 'main', ahead: 2, behind: 0 },
  commits: [], uncommitted: [], integrations: {},
};

function renderTab(changes: ChangesPayload | null) {
  return render(
    <MemoryRouter>
      <ChangesTab run={run} project={project} changes={changes}
        onCreatePr={vi.fn()} creatingPr={false} onReload={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('ChangesTab', () => {
  it('shows loading state when changes is null', () => {
    renderTab(null);
    expect(screen.getByText(/Loading changes/i)).toBeInTheDocument();
  });
  it('shows empty state when no commits and no uncommitted', () => {
    renderTab(base);
    expect(screen.getByText(/No changes yet/i)).toBeInTheDocument();
  });
  it('renders Uncommitted synthetic row when there are dirty files', () => {
    renderTab({ ...base, uncommitted: [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }] });
    expect(screen.getByText(/Uncommitted \(1\)/)).toBeInTheDocument();
  });
  it('renders commits', () => {
    renderTab({ ...base, commits: [
      { sha: 'abcdef0123', subject: 'feat: x', committed_at: Math.floor(Date.now()/1000) - 60, pushed: true, files: [], files_loaded: false },
    ] });
    expect(screen.getByText('feat: x')).toBeInTheDocument();
    expect(screen.getByText('abcdef0')).toBeInTheDocument();
  });
  it('hides integration strip when no github data', () => {
    renderTab(base);
    expect(screen.queryByText(/^github/)).not.toBeInTheDocument();
  });
  it('renders integration strip when github payload present', () => {
    renderTab({
      ...base,
      integrations: {
        github: { pr: { number: 3, url: '#', state: 'OPEN', title: 't' },
          checks: { state: 'success', passed: 1, failed: 0, total: 1, items: [] } },
      },
    });
    expect(screen.getByText(/PR #3/)).toBeInTheDocument();
    expect(screen.getByText(/ci 1\/1/)).toBeInTheDocument();
  });
});
