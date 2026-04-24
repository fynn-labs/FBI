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
        ⚠ Mirror to <code className="font-mono">{baseBranch}</code> is out of sync.
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={onRebase}
          className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Rebase & retry
        </button>
        <button type="button" onClick={onStop}
          className="text-text-faint hover:text-text">
          Stop mirroring
        </button>
      </div>
    </section>
  );
}
