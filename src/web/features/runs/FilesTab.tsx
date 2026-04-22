import { DiffRow } from '@ui/data/DiffRow.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';
import type { Project } from '@shared/types.js';

export interface FilesTabProps {
  diff: { github_available: boolean; head: string; files: Array<{ status: string; filename: string; additions: number; deletions: number }> } | null;
  project: Project | null;
}

export function FilesTab({ diff, project }: FilesTabProps) {
  if (!diff) return <LoadingState label="Loading diff…" />;
  if (!diff.github_available) return <p className="p-3 text-[11px] text-text-faint">GitHub CLI not available or non-GitHub remote.</p>;
  if (diff.files.length === 0) return <p className="p-3 text-[11px] text-text-faint">No files changed.</p>;
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  return (
    <div className="py-1">
      {diff.files.map((f) => (
        <DiffRow
          key={f.filename}
          status={(['added', 'modified', 'removed', 'renamed'] as const).find((s) => s.startsWith(f.status.toLowerCase())) ?? 'modified'}
          filename={f.filename}
          href={repo ? `https://github.com/${repo}/blob/${diff.head}/${f.filename}` : undefined}
          additions={f.additions}
          deletions={f.deletions}
        />
      ))}
    </div>
  );
}
