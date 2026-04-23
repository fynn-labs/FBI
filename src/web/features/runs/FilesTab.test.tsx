import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FilesTab } from './FilesTab.js';
import type { FilesPayload } from '@shared/types.js';

const base: FilesPayload = { dirty: [], head: null, headFiles: [], branchBase: null, live: true };

describe('FilesTab', () => {
  it('shows empty-state when no changes', () => {
    render(<FilesTab runId={1} files={base} project={null} branchName={null} runState="running" />);
    expect(screen.getByText(/no file changes yet/i)).toBeInTheDocument();
  });

  it('renders dirty rows with status and stats', () => {
    render(<FilesTab runId={1}
      files={{ ...base, dirty: [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }] }}
      project={null} branchName={null} runState="running" />);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
  });

  it('shows last commit subject and head files', () => {
    render(<FilesTab runId={1}
      files={{ ...base, head: { sha: 'a3f2b19abc', subject: 'feat: x' }, headFiles: [{ path: 'src/b.ts', status: 'A', additions: 10, deletions: 0 }] }}
      project={null} branchName={null} runState="succeeded" />);
    expect(screen.getByText('feat: x')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('renders loading state when files is null', () => {
    render(<FilesTab runId={1} files={null} project={null} branchName={null} runState="running" />);
    expect(screen.getByText(/loading files/i)).toBeInTheDocument();
  });

  it('renders ahead/behind when branchBase is present', () => {
    render(<FilesTab runId={1}
      files={{ ...base, branchBase: { base: 'main', ahead: 3, behind: 0 } }}
      project={null} branchName="feat/x" runState="running" />);
    expect(screen.getByText(/3 ahead/)).toBeInTheDocument();
    expect(screen.getByText(/0 behind/)).toBeInTheDocument();
  });

  it('renders snapshot hint when files.live is false', () => {
    render(<FilesTab runId={1}
      files={{ ...base, branchBase: { base: 'main', ahead: 0, behind: 0 }, live: false }}
      project={null} branchName="feat/x" runState="succeeded" />);
    expect(screen.getByText('snapshot')).toBeInTheDocument();
  });
});
