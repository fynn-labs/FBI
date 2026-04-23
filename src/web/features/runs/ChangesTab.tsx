import { ChangesHeader } from './ChangesHeader.js';
import { IntegrationStrip } from './IntegrationStrip.js';
import { CommitRow } from './CommitRow.js';
import { useHistoryOp } from './useHistoryOp.js';
import type { ChangesPayload, MergeStrategy, Project, Run } from '@shared/types.js';

export interface ChangesTabProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload | null;
  onCreatePr: () => void;
  creatingPr: boolean;
  onReload: () => void;
}

export function ChangesTab({ run, project, changes, onCreatePr, creatingPr, onReload }: ChangesTabProps) {
  const { busy, msg, run: runOp } = useHistoryOp(run.id, onReload);

  if (!changes) return <p className="p-3 text-[13px] text-text-faint">Loading changes…</p>;
  if (!changes.branch_name) return <p className="p-3 text-[13px] text-text-faint">This run didn't produce a branch.</p>;

  const empty = changes.commits.length === 0 && changes.uncommitted.length === 0;

  return (
    <div>
      <ChangesHeader
        run={run} project={project} changes={changes}
        creatingPr={creatingPr} merging={busy}
        onCreatePr={onCreatePr}
        onMerge={(strategy?: MergeStrategy) => runOp({ op: 'merge', strategy })}
        onSync={() => runOp({ op: 'sync' })}
        onSquashLocal={(subject) => runOp({ op: 'squash-local', subject })}
        onPolish={() => runOp({ op: 'polish' })}
      />
      <IntegrationStrip integrations={changes.integrations} />
      {msg && <p className="px-3 py-1 text-[12px] text-text-dim bg-surface-raised border-b border-border">{msg}</p>}

      {empty ? (
        <p className="p-3 text-[13px] text-text-faint">No changes yet. The agent hasn't committed anything.</p>
      ) : (
        <div>
          {changes.uncommitted.length > 0 && (
            <CommitRow
              runId={run.id}
              sha="uncommitted"
              shortSha={null}
              pushed={null}
              subject={`Uncommitted (${changes.uncommitted.length})`}
              fileCount={changes.uncommitted.length}
              relativeTime="working tree"
              uncommitted
              defaultOpen
              initialFiles={changes.uncommitted}
              initialFilesLoaded
            />
          )}
          {changes.commits.map((c) => (
            <CommitRow
              key={c.sha}
              runId={run.id}
              sha={c.sha}
              shortSha={c.sha.slice(0, 7)}
              pushed={c.pushed}
              subject={c.subject}
              fileCount={c.files_loaded ? c.files.length : 0}
              relativeTime={relativeTime(c.committed_at)}
              initialFiles={c.files_loaded ? c.files : undefined}
              initialFilesLoaded={c.files_loaded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function relativeTime(unixSeconds: number): string {
  const diffMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
