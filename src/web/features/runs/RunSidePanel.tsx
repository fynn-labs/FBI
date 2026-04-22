import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Pill, type PillTone } from '@ui/primitives/index.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import { TimestampRelative } from '@ui/data/TimestampRelative.js';
import type { Run } from '@shared/types.js';
import { RunUsage } from './RunUsage.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', running: 'run', awaiting_resume: 'warn',
  succeeded: 'ok', failed: 'fail', cancelled: 'warn',
};

function formatReset(ms: number | null): string | null {
  if (ms == null) return null;
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'any moment';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export interface RunSidePanelProps {
  run: Run;
  siblings: readonly Run[];
  github: { pr?: { number: number; url: string; title: string; state: string } | null; checks?: { state: string; passed: number; failed: number; total: number } | null; github_available: boolean } | null;
  onCreatePr: () => void;
  creatingPr: boolean;
}

export function RunSidePanel({ run, siblings, github, onCreatePr, creatingPr }: RunSidePanelProps) {
  return (
    <aside className="w-[200px] shrink-0 border-l border-border-strong bg-surface p-2 overflow-auto">
      <Group label="Info">
        <Row label="project"><CodeBlock>#{run.project_id}</CodeBlock></Row>
        <Row label="started"><TimestampRelative iso={new Date(run.created_at).toISOString()} /></Row>
        {run.branch_name && <Row label="branch"><CodeBlock>{run.branch_name}</CodeBlock></Row>}
      </Group>

      {run.state === 'awaiting_resume' && (
        <Group label="Auto-resume">
          {run.next_resume_at != null && (
            <Row label="resumes in"><span className="font-mono text-warn">{formatReset(run.next_resume_at)}</span></Row>
          )}
          <Row label="attempts"><span className="font-mono">{run.resume_attempts}</span></Row>
        </Group>
      )}

      <RunUsage run={run} />

      {github && run.state === 'succeeded' && (
        <Group label="GitHub">
          {!github.github_available ? (
            <p className="text-[12px] text-text-faint">no gh / non-github</p>
          ) : github.pr ? (
            <>
              <a href={github.pr.url} target="_blank" rel="noreferrer" className="block text-[12px] text-accent underline">
                PR #{github.pr.number}
              </a>
              <p className="text-[12px] text-text-dim truncate">{github.pr.title}</p>
              {github.checks && (
                <p className="text-[12px] text-text-faint mt-1">
                  CI: <span className={github.checks.state === 'success' ? 'text-ok' : github.checks.state === 'failure' ? 'text-fail' : 'text-text-faint'}>
                    {github.checks.state}
                  </span> ({github.checks.passed}/{github.checks.total})
                </p>
              )}
            </>
          ) : (
            <button
              onClick={onCreatePr}
              disabled={creatingPr}
              className="text-[12px] text-accent hover:text-accent-strong disabled:opacity-50"
            >
              {creatingPr ? 'Creating…' : 'Create PR'}
            </button>
          )}
        </Group>
      )}

      {siblings.length > 0 && (
        <Group label="Related">
          {siblings.map((s) => (
            <Link key={s.id} to={`/runs/${s.id}`} className="flex items-center gap-1 text-[12px] text-text-dim hover:text-text py-0.5">
              <span className="font-mono">#{s.id}</span>
              <Pill tone={TONE[s.state]}>{s.state}</Pill>
              <span className="truncate text-text-faint">{s.branch_name}</span>
            </Link>
          ))}
        </Group>
      )}
    </aside>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-faint pb-1 border-b border-border mb-1">{label}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-center gap-1 text-[12px] text-text-dim py-0.5"><span className="text-text-faint">{label}</span><span className="ml-auto">{children}</span></div>;
}
