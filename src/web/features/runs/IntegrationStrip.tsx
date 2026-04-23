import type { ChangesPayload } from '@shared/types.js';
import { ExternalLink } from '@ui/primitives/icons/ExternalLink.js';

export interface IntegrationStripProps {
  integrations: ChangesPayload['integrations'];
}

export function IntegrationStrip({ integrations }: IntegrationStripProps) {
  if (!integrations.github) return null;
  const { pr, checks } = integrations.github;
  const dot = checks?.state === 'failure' ? 'bg-fail'
    : checks?.state === 'pending' ? 'bg-warn animate-pulse'
    : 'bg-ok';
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[12px] text-text-faint border-b border-border">
      <span>github</span>
      {pr && (
        <>
          <span>·</span>
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong inline-flex items-center gap-1">
            PR #{pr.number} — {pr.title} <ExternalLink />
          </a>
          <span className={`ml-1 px-1.5 py-0 rounded-sm text-[10px] font-semibold uppercase ${pr.state === 'MERGED' ? 'bg-ok-subtle text-ok' : pr.state === 'OPEN' ? 'bg-run-subtle text-run' : 'bg-surface-raised text-text-dim'}`}>
            {pr.state.toLowerCase()}
          </span>
        </>
      )}
      {checks && (
        <>
          <span>·</span>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
          <span>ci {checks.passed}/{checks.total}</span>
        </>
      )}
    </div>
  );
}
