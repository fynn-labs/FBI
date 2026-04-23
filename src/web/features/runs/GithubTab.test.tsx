import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GithubTab } from './GithubTab.js';
import type { Run, GithubPayload } from '@shared/types.js';

const baseRun = {
  id: 1, state: 'running', branch_name: 'feat/x', project_id: 1,
} as unknown as Run;

const basePayload: GithubPayload = {
  pr: null, checks: null, commits: [], github_available: true,
};

describe('GithubTab', () => {
  it('shows loading when github is null', () => {
    render(<GithubTab run={baseRun} github={null} onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows Create PR when no PR exists', () => {
    render(<GithubTab run={baseRun} github={basePayload} onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText('Create PR')).toBeInTheDocument();
  });

  it('shows Merge to main when PR exists and run is running', () => {
    render(<GithubTab run={baseRun}
      github={{ ...basePayload, pr: { number: 3, url: '#', state: 'OPEN', title: 't' } }}
      onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText('Merge to main')).toBeInTheDocument();
  });

  it('lists commits with pushed/unpushed indicator', () => {
    render(<GithubTab run={baseRun}
      github={{
        ...basePayload,
        commits: [
          { sha: 'abcdef01', subject: 'feat: x', committed_at: 1, pushed: true },
          { sha: '12345678', subject: 'wip', committed_at: 2, pushed: false },
        ],
      }}
      onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText('feat: x')).toBeInTheDocument();
    expect(screen.getByText('abcdef0')).toBeInTheDocument();
    expect(screen.getByLabelText('pushed')).toBeInTheDocument();
    expect(screen.getByLabelText('not yet pushed')).toBeInTheDocument();
  });

  it('non-GitHub repo: shows fallback notice, suppresses actions', () => {
    render(<GithubTab run={baseRun}
      github={{ ...basePayload, github_available: false }}
      onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText(/non-GitHub remote/i)).toBeInTheDocument();
    expect(screen.queryByText('Create PR')).not.toBeInTheDocument();
  });

  it('shows CI items with status', () => {
    render(<GithubTab run={baseRun}
      github={{
        ...basePayload,
        pr: { number: 3, url: '#', state: 'OPEN', title: 't' },
        checks: {
          state: 'success', passed: 1, failed: 0, total: 1,
          items: [{ name: 'test (node 20)', status: 'completed', conclusion: 'success', duration_ms: 42 }],
        },
      }}
      onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText('test (node 20)')).toBeInTheDocument();
    expect(screen.getByText(/1\/1 passed/)).toBeInTheDocument();
  });
});
