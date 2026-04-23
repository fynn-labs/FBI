import { useState } from 'react';
import { api } from '../../lib/api.js';
import { DiffBlock } from '@ui/data/DiffBlock.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { Pill, type PillTone } from '@ui/primitives/Pill.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';
import type { FilesPayload, FileDiffPayload, Project, RunState } from '@shared/types.js';

export interface FilesTabProps {
  runId: number;
  files: FilesPayload | null;
  project: Project | null;
  branchName: string | null;
  runState: RunState;
}

type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';
const STATUS_TONE: Record<FileStatus, PillTone> = {
  M: 'warn',
  A: 'ok',
  D: 'fail',
  R: 'attn',
  U: 'wait',
};

type DiffRow = FileDiffPayload | 'loading' | 'error';

export function FilesTab({ runId, files, project, branchName, runState }: FilesTabProps) {
  const [expanded, setExpanded] = useState<Record<string, DiffRow>>({});

  const toggle = async (key: string, path: string, ref: string): Promise<void> => {
    const existing = expanded[key];
    if (existing && existing !== 'loading') {
      setExpanded((e) => {
        const next = { ...e };
        delete next[key];
        return next;
      });
      return;
    }
    setExpanded((e) => ({ ...e, [key]: 'loading' }));
    try {
      const d = await api.getRunFileDiff(runId, path, ref);
      setExpanded((e) => ({ ...e, [key]: d }));
    } catch {
      setExpanded((e) => ({ ...e, [key]: 'error' }));
    }
  };

  if (!files) {
    if (runState === 'queued') return <p className="p-3 text-[13px] text-text-faint">Run queued — no files yet.</p>;
    return <LoadingState label="Loading files…" />;
  }

  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const branchHref = repo && branchName
    ? `https://github.com/${repo}/tree/${encodeURIComponent(branchName)}`
    : undefined;

  const empty = files.dirty.length === 0 && (!files.head || files.headFiles.length === 0);

  return (
    <div>
      {(files.branchBase || branchName) && (
        <div className="flex items-center gap-3 px-3 py-2 text-[12px] text-text-dim border-b border-border">
          <span className="text-text-faint">branch</span>
          {branchHref ? (
            <a href={branchHref} target="_blank" rel="noreferrer" className="font-mono text-accent hover:text-accent-strong">{branchName}</a>
          ) : (
            <span className="font-mono text-text">{branchName}</span>
          )}
          {files.branchBase && (
            <>
              <span className="text-text-faint">·</span>
              <span>
                <span className="text-ok">{files.branchBase.ahead} ahead</span>
                <span className="text-text-faint"> / </span>
                <span className="text-text-faint">{files.branchBase.behind} behind</span>
              </span>
            </>
          )}
          {!files.live && <span className="ml-auto text-text-faint">snapshot</span>}
        </div>
      )}

      {files.dirty.length > 0 && (
        <>
          <SectionLabel>Uncommitted ({files.dirty.length})</SectionLabel>
          {files.dirty.map((f) => {
            const key = `w:${f.path}`;
            const row = expanded[key];
            return (
              <div key={key}>
                <FileRow
                  path={f.path} status={f.status} additions={f.additions} deletions={f.deletions}
                  open={!!row && row !== 'loading'}
                  onClick={() => toggle(key, f.path, 'worktree')}
                />
                {row === 'loading' && <p className="px-3 py-1 text-[12px] text-text-faint">Loading diff…</p>}
                {row === 'error' && <p className="px-3 py-1 text-[12px] text-fail">Failed to load diff.</p>}
                {row && typeof row === 'object' && <DiffBlock hunks={row.hunks} truncated={row.truncated} />}
              </div>
            );
          })}
        </>
      )}

      {files.head && files.headFiles.length > 0 && (
        <>
          <SectionLabel>Last commit</SectionLabel>
          <div className="px-3 py-1 text-[12px]">
            <span className="text-text-faint font-mono">{files.head.sha.slice(0, 7)}</span>
            <span className="ml-2 text-text">{files.head.subject}</span>
          </div>
          {files.headFiles.map((f) => {
            const key = `h:${f.path}`;
            const row = expanded[key];
            return (
              <div key={key}>
                <FileRow
                  path={f.path} status={f.status} additions={f.additions} deletions={f.deletions}
                  open={!!row && row !== 'loading'}
                  onClick={() => toggle(key, f.path, files.head!.sha)}
                />
                {row === 'loading' && <p className="px-3 py-1 text-[12px] text-text-faint">Loading diff…</p>}
                {row === 'error' && <p className="px-3 py-1 text-[12px] text-fail">Failed to load diff.</p>}
                {row && typeof row === 'object' && <DiffBlock hunks={row.hunks} truncated={row.truncated} />}
              </div>
            );
          })}
        </>
      )}

      {empty && <p className="p-3 text-[13px] text-text-faint">No file changes yet.</p>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-text-faint bg-surface-raised border-t border-b border-border">
      {children}
    </div>
  );
}

function FileRow({ path, status, additions, deletions, open, onClick }: {
  path: string; status: FileStatus; additions: number; deletions: number; open: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1 text-[13px] hover:bg-surface-raised border-b border-border text-left"
    >
      <Chevron open={open} />
      <Pill tone={STATUS_TONE[status]}>{status}</Pill>
      <span className="font-mono text-text flex-1 truncate">{path}</span>
      {additions > 0 && <span className="font-mono text-[12px] text-ok">+{additions}</span>}
      {deletions > 0 && <span className="font-mono text-[12px] text-fail">-{deletions}</span>}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={`transition-transform duration-fast ease-out text-text-faint ${open ? 'rotate-90' : ''}`}
    >
      <path d="M3.5 2.5 L6.5 5 L3.5 7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
