import type { MirrorStatus } from '@shared/types.js';

export interface MirrorStatusBannerProps {
  status: MirrorStatus;
  baseBranch: string | null;
  runId: number;
  onRebase: () => void;
  onStop: () => void;
}

export function MirrorStatusBanner({ status, baseBranch, onRebase, onStop }: MirrorStatusBannerProps) {
  if (status !== 'diverged' || !baseBranch) return null;
  return (
    <section className="px-4 py-3 border-b border-border bg-warn-subtle/20 border-l-2 border-l-warn text-[13px]">
      <div className="font-semibold text-text">
        ⚠ Branch <code className="font-mono">{baseBranch}</code> diverged on origin.
      </div>
      <p className="mt-1 text-text-dim">
        Someone pushed commits we don't have locally. Sync to integrate, or dismiss to keep trying.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={onRebase}
          className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Sync & retry
        </button>
        <button type="button" onClick={onStop}
          className="text-text-faint hover:text-text">
          Dismiss
        </button>
      </div>
    </section>
  );
}
