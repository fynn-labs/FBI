import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChangesHeader } from './ChangesHeader.js';
import type { ChangesPayload, Run, Project } from '@shared/types.js';

const run = { id: 1, state: 'running', branch_name: 'feat/x', project_id: 1, prompt: 'do it', title: null } as unknown as Run;
const project = { id: 1, repo_url: 'git@github.com:me/foo.git', default_merge_strategy: 'squash' } as unknown as Project;
const baseChanges: ChangesPayload = {
  branch_name: 'feat/x',
  branch_base: { base: 'main', ahead: 4, behind: 0 },
  commits: [], uncommitted: [], integrations: {},
};

describe('ChangesHeader', () => {
  const handlers = {
    onCreatePr: vi.fn(), onMerge: vi.fn(), onSync: vi.fn(),
    onSquashLocal: vi.fn(), onPolish: vi.fn(),
  };

  it('shows Sync button when behind > 0', () => {
    render(<ChangesHeader run={run} project={project} changes={{ ...baseChanges, branch_base: { base: 'main', ahead: 4, behind: 3 } }}
      creatingPr={false} merging={false} {...handlers} />);
    expect(screen.getByText(/Sync with main/)).toBeInTheDocument();
  });

  it('hides Sync when up to date', () => {
    render(<ChangesHeader run={run} project={project} changes={baseChanges}
      creatingPr={false} merging={false} {...handlers} />);
    expect(screen.queryByText(/Sync with main/)).not.toBeInTheDocument();
  });

  it('menu: strategy checkmark follows project default', () => {
    render(<ChangesHeader run={run} project={project} changes={baseChanges}
      creatingPr={false} merging={false} {...handlers} />);
    fireEvent.click(screen.getByLabelText('More actions'));
    const squash = screen.getByText('Squash & merge').closest('button')!;
    const merge = screen.getByText('Merge commit').closest('button')!;
    expect(squash.querySelector('svg')).not.toBeNull();
    expect(merge.querySelector('svg')).toBeNull();
  });

  it('Merge button calls onMerge without strategy (uses project default)', () => {
    const onMerge = vi.fn();
    render(<ChangesHeader run={run} project={project} changes={baseChanges}
      creatingPr={false} merging={false} {...handlers} onMerge={onMerge} />);
    fireEvent.click(screen.getByText('Merge to main'));
    expect(onMerge).toHaveBeenCalledWith();
  });
});
