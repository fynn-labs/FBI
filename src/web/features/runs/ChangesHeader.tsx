import { Menu, type MenuSection } from '@ui/primitives/Menu.js';
import type { ChangesPayload, MergeStrategy, Project, Run } from '@shared/types.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';

export interface ChangesHeaderProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload;
  creatingPr: boolean;
  merging: boolean;
  onCreatePr: () => void;
  onMerge: (strategy?: MergeStrategy) => void;
  onSync: () => void;
  onSquashLocal: (subject: string) => void;
  onPolish: () => void;
}

export function ChangesHeader({
  run, project, changes, creatingPr, merging,
  onCreatePr, onMerge, onSync, onSquashLocal, onPolish,
}: ChangesHeaderProps) {
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const branchHref = repo && changes.branch_name
    ? `https://github.com/${repo}/tree/${encodeURIComponent(changes.branch_name)}`
    : undefined;

  const behind = changes.branch_base?.behind ?? 0;
  const ahead = changes.branch_base?.ahead ?? 0;
  const active = run.state === 'running' || run.state === 'waiting' || run.state === 'succeeded';
  const canMerge = active && !!changes.branch_name;
  const canCreatePr = !!changes.integrations.github && !changes.integrations.github.pr && !!changes.branch_name;

  const sections: MenuSection[] = [
    {
      label: 'Merge strategy',
      items: [
        { id: 'merge', label: 'Merge commit',
          checked: project?.default_merge_strategy === 'merge',
          onSelect: () => onMerge('merge') },
        { id: 'rebase', label: 'Rebase & fast-forward',
          checked: project?.default_merge_strategy === 'rebase',
          onSelect: () => onMerge('rebase') },
        { id: 'squash', label: 'Squash & merge',
          checked: project?.default_merge_strategy === 'squash',
          onSelect: () => onMerge('squash') },
      ],
    },
    {
      label: 'History',
      items: [
        { id: 'sync', label: 'Sync branch with main', hint: 'rebase',
          disabled: !changes.branch_name, onSelect: onSync },
        { id: 'squash-local', label: 'Squash local commits',
          disabled: changes.commits.length < 2,
          onSelect: () => {
            const subj = window.prompt('Squashed commit subject:', run.title ?? (run.prompt.split('\n')[0] ?? '').slice(0, 72));
            if (subj) onSquashLocal(subj);
          } },
        { id: 'polish', label: 'Polish commits with agent', hint: 'sub-run',
          disabled: changes.commits.length === 0, onSelect: onPolish },
      ],
    },
    {
      label: 'Misc',
      items: [
        { id: 'copy', label: 'Copy branch name',
          disabled: !changes.branch_name,
          onSelect: () => { if (changes.branch_name) void navigator.clipboard.writeText(changes.branch_name); } },
        { id: 'open', label: 'Open branch on GitHub ↗',
          disabled: !branchHref,
          onSelect: () => { if (branchHref) window.open(branchHref, '_blank', 'noreferrer'); } },
      ],
    },
  ];

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-surface-raised">
      {changes.branch_name ? (
        branchHref
          ? <a href={branchHref} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-accent hover:text-accent-strong">{changes.branch_name}</a>
          : <span className="font-mono text-[13px] text-text">{changes.branch_name}</span>
      ) : <span className="text-[13px] text-text-faint">no branch</span>}
      <span className="text-text-faint">·</span>
      <span className="font-mono text-[12px] text-ok">{ahead} ahead</span>
      <span className="font-mono text-[12px] text-text-faint">/</span>
      <span className={`font-mono text-[12px] ${behind > 0 ? 'text-warn font-medium' : 'text-text-faint'}`}>{behind} behind</span>
      <span className="text-text-faint font-mono text-[12px]">main</span>

      <span className="flex-1" />

      {behind > 0 && (
        <button type="button" onClick={onSync} disabled={merging}
          className="px-3 py-1 text-[12px] rounded-md border border-warn/50 bg-warn-subtle text-warn hover:bg-warn-subtle/70 disabled:opacity-50 animate-pulse">
          Sync with main ↓
        </button>
      )}
      {canMerge && (
        <button type="button" onClick={() => onMerge()} disabled={merging}
          className="px-3 py-1 text-[12px] rounded-md bg-accent text-bg hover:bg-accent-strong disabled:opacity-50 font-medium">
          {merging ? 'Merging…' : 'Merge to main'}
        </button>
      )}
      {canCreatePr && (
        <button type="button" onClick={onCreatePr} disabled={creatingPr}
          className="px-3 py-1 text-[12px] rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised disabled:opacity-50">
          {creatingPr ? 'Creating PR…' : 'Create PR'}
        </button>
      )}
      <Menu
        trigger={<button type="button" aria-label="More actions" className="px-2 py-1 text-[13px] text-text-faint hover:text-text">⋮</button>}
        sections={sections}
      />
    </div>
  );
}
