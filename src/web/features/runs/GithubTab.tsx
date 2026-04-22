import { Pill } from '@ui/primitives/Pill.js';

export interface GithubTabProps {
  github: { pr?: { number: number; url: string; title: string; state: string } | null; checks?: { state: string; passed: number; failed: number; total: number } | null; github_available: boolean } | null;
}

export function GithubTab({ github }: GithubTabProps) {
  if (!github) return <p className="p-3 text-[12px] text-text-faint">Loading…</p>;
  if (!github.github_available) return <p className="p-3 text-[12px] text-text-faint">GitHub CLI not available or non-GitHub remote.</p>;
  return (
    <div className="p-3 space-y-2 text-[13px]">
      {github.pr ? (
        <a href={github.pr.url} target="_blank" rel="noreferrer" className="text-accent">PR #{github.pr.number} — {github.pr.title}</a>
      ) : (
        <p className="text-text-dim">No PR yet.</p>
      )}
      {github.checks && (
        <p>CI: <Pill tone={github.checks.state === 'success' ? 'ok' : github.checks.state === 'failure' ? 'fail' : 'wait'}>{github.checks.state}</Pill> ({github.checks.passed}/{github.checks.total} passed, {github.checks.failed} failed)</p>
      )}
    </div>
  );
}
