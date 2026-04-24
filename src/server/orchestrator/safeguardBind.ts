import path from 'node:path';

/** Computes the docker `Binds` entry for a run's safeguard bare repo.
 *  Maps `<runsDir>/<id>/wip.git` to `/safeguard` inside the container.
 *  When the host daemon sees runs at a different path than the server
 *  process, pass `hostRunsDir` to rewrite the left-hand side. */
export function buildSafeguardBind(
  runsDir: string,
  runId: number,
  hostRunsDir?: string,
): string {
  const base = hostRunsDir ?? runsDir;
  return `${path.join(base, String(runId), 'wip.git')}:/safeguard:rw`;
}
