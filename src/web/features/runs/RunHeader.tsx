import { useNavigate } from 'react-router-dom';
import { Button, Pill, Menu, type PillTone } from '@ui/primitives/index.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import type { Run } from '@shared/types.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', running: 'run', succeeded: 'ok', failed: 'fail', cancelled: 'warn',
};

export interface RunHeaderProps {
  run: Run;
  onCancel: () => void;
  onDelete: () => void;
}

export function RunHeader({ run, onCancel, onDelete }: RunHeaderProps) {
  const nav = useNavigate();
  const canFollowUp = run.state !== 'running' && run.state !== 'queued' && !!run.branch_name;
  return (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-border-strong bg-surface">
      <h1 className="text-[14px] font-semibold">Run #{run.id}</h1>
      <Pill tone={TONE[run.state]}>{run.state}</Pill>
      {run.branch_name && <CodeBlock>{run.branch_name}{run.head_commit ? `@${run.head_commit.slice(0,8)}` : ''}</CodeBlock>}
      <div className="ml-auto flex gap-1.5">
        {canFollowUp && <Button variant="ghost" size="sm" onClick={() => nav(`/projects/${run.project_id}/runs/new?branch=${encodeURIComponent(run.branch_name!)}`)}>Follow up</Button>}
        {run.state === 'running' && <Button variant="danger" size="sm" onClick={onCancel}>Cancel</Button>}
        <Menu
          trigger={<Button variant="ghost" size="sm">More ▾</Button>}
          items={[
            { id: 'delete', label: 'Delete run', danger: true, onSelect: onDelete, disabled: run.state === 'running' },
          ]}
        />
      </div>
    </header>
  );
}
