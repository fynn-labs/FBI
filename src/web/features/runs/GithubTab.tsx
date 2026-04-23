import { useState } from 'react';
import { Pill, type PillTone } from '@ui/primitives/Pill.js';
import { ExternalLink } from '@ui/primitives/icons/ExternalLink.js';
import { api } from '../../lib/api.js';
import type { GithubPayload, Run } from '@shared/types.js';

export interface GithubTabProps {
  run: Run;
  github: GithubPayload | null;
  onCreatePr: () => void;
  onMerged: () => void;
  creatingPr: boolean;
}

const PR_STATE_TONE: Record<'OPEN' | 'CLOSED' | 'MERGED', PillTone> = {
  OPEN: 'run',
  CLOSED: 'wait',
  MERGED: 'ok',
};

export function GithubTab({ run, github, onCreatePr, onMerged, creatingPr }: GithubTabProps) {
  const [merging, setMerging] = useState(false);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);

  if (!github) return <p className="p-3 text-[13px] text-text-faint">Loading…</p>;

  const canCreatePr = github.github_available && !github.pr && !!run.branch_name;
  const canMerge = github.github_available && !!github.pr
    && github.pr.state === 'OPEN'
    && (run.state === 'running' || run.state === 'waiting' || run.state === 'succeeded');

  async function onMergeClick(): Promise<void> {
    setMerging(true);
    setMergeMsg(null);
    try {
      const r = await api.mergeRunBranch(run.id);
      if (r.merged) {
        setMergeMsg(`Merged as ${r.sha.slice(0, 7)}`);
        onMerged();
      } else if (r.reason === 'conflict' && 'agent' in r && r.agent) {
        setMergeMsg('Conflicts — delegated to agent');
      } else {
        setMergeMsg(`Merge failed: ${r.reason}`);
      }
    } catch (e) {
      setMergeMsg(String(e));
    } finally {
      setMerging(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        {canCreatePr && (
          <button
            type="button"
            onClick={onCreatePr}
            disabled={creatingPr}
            className="px-3 py-1 text-[13px] bg-accent text-bg rounded-md hover:bg-accent-strong disabled:opacity-50"
          >
            {creatingPr ? 'Creating PR…' : 'Create PR'}
          </button>
        )}
        {canMerge && (
          <button
            type="button"
            onClick={onMergeClick}
            disabled={merging}
            className="px-3 py-1 text-[13px] bg-accent text-bg rounded-md hover:bg-accent-strong disabled:opacity-50"
          >
            {merging ? 'Merging…' : 'Merge to main'}
          </button>
        )}
        {!github.github_available && (
          <span className="text-[12px] text-text-faint">GitHub CLI not available / non-GitHub remote</span>
        )}
      </div>

      {mergeMsg && <p className="px-3 py-1 text-[12px] text-text-dim">{mergeMsg}</p>}

      <Section label="Pull request">
        {github.pr ? (
          <a
            href={github.pr.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-surface-raised border-b border-border group"
          >
            <span className="font-mono text-text-faint">#{github.pr.number}</span>
            <span className="text-text truncate flex-1 group-hover:text-accent">{github.pr.title}</span>
            <Pill tone={PR_STATE_TONE[github.pr.state]}>{github.pr.state.toLowerCase()}</Pill>
            <ExternalLink className="text-text-faint group-hover:text-accent" />
          </a>
        ) : (
          <p className="px-3 py-2 text-[13px] text-text-faint">No PR yet.</p>
        )}
      </Section>

      {github.checks && (
        <Section label={`CI (${github.checks.passed}/${github.checks.total} passed)`}>
          {github.checks.items.map((c) => {
            const tone: PillTone = c.conclusion === 'success' ? 'ok'
              : c.conclusion === 'failure' ? 'fail'
              : 'wait';
            return (
              <div key={c.name} className="flex items-center gap-2 px-3 py-1 text-[13px] border-b border-border">
                <Pill tone={tone}>{c.conclusion ?? c.status}</Pill>
                <span className="font-mono truncate flex-1">{c.name}</span>
              </div>
            );
          })}
        </Section>
      )}

      {github.commits.length > 0 && (
        <Section label={`Commits on ${run.branch_name ?? 'branch'} (${github.commits.length})`}>
          {github.commits.map((c) => (
            <div key={c.sha} className="flex items-center gap-2 px-3 py-1 text-[13px] border-b border-border">
              <span
                className={`w-1.5 h-1.5 rounded-full ${c.pushed ? 'bg-ok' : 'bg-text-faint'}`}
                title={c.pushed ? 'pushed' : 'not yet pushed'}
                aria-label={c.pushed ? 'pushed' : 'not yet pushed'}
              />
              <span className="font-mono text-text-faint">{c.sha.slice(0, 7)}</span>
              <span className="text-text truncate flex-1">{c.subject}</span>
            </div>
          ))}
        </Section>
      )}

      {github.github_available && github.commits.length === 0 && !github.pr && (
        <p className="p-3 text-[13px] text-text-faint">No commits on this branch yet.</p>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-text-faint bg-surface-raised border-t border-b border-border">
        {label}
      </div>
      {children}
    </section>
  );
}
