import { ShipHeader } from './ShipHeader.js';
import { MergePrimary } from './MergePrimary.js';
import { HistorySection } from './HistorySection.js';
import { AgentSection } from './AgentSection.js';
import { SubmodulesSection } from './SubmodulesSection.js';
import { LinksSection } from './LinksSection.js';
import { SubRunsSection } from './SubRunsSection.js';
import { MirrorStatusBanner } from './MirrorStatusBanner.js';
import { useHistoryOp } from '../useHistoryOp.js';
import { api } from '../../../lib/api.js';
import type { ChangesPayload, MergeStrategy, Project, Run } from '@shared/types.js';

export interface ShipTabProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload | null;
  onCreatePr: () => void;
  creatingPr: boolean;
  onReload: () => void;
}

export function ShipTab({ run, project, changes, onCreatePr, creatingPr, onReload }: ShipTabProps) {
  const { busy, msg, run: runOp } = useHistoryOp(run.id, onReload);

  if (!changes) return <p className="p-4 text-[13px] text-text-faint">Loading ship data…</p>;
  if (!changes.branch_name) return <p className="p-4 text-[13px] text-text-faint">This run didn't produce a branch.</p>;

  const defaultStrategy: MergeStrategy = project?.default_merge_strategy ?? 'squash';

  return (
    <div>
      <MirrorStatusBanner
        status={run.mirror_status}
        baseBranch={run.base_branch}
        runId={run.id}
        onRebase={() => void runOp({ op: 'mirror-rebase' })}
        onStop={async () => {
          await api.clearRunBaseBranch(run.id);
          onReload();
        }}
      />
      <ShipHeader changes={changes} runState={run.state} />
      {msg && <p className="px-4 py-1 text-[12px] text-text-dim bg-surface-raised border-y border-border">{msg}</p>}
      <MergePrimary
        changes={changes}
        projectDefault={defaultStrategy}
        busy={busy}
        onMerge={(strategy) => runOp({ op: 'merge', strategy })}
      />
      <HistorySection
        changes={changes}
        busy={busy}
        onSync={() => runOp({ op: 'sync' })}
        onSquashLocal={(subject) => runOp({ op: 'squash-local', subject })}
      />
      <AgentSection
        busy={busy}
        commitsCount={changes.commits.length}
        onPolish={() => runOp({ op: 'polish' })}
      />
      <SubmodulesSection
        changes={changes}
        busy={busy}
        onPushSubmodule={(path) => runOp({ op: 'push-submodule', path })}
      />
      <LinksSection
        changes={changes}
        project={project}
        creatingPr={creatingPr}
        onCreatePr={onCreatePr}
      />
      <SubRunsSection children={changes.children} />
    </div>
  );
}
