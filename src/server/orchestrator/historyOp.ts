import type Docker from 'dockerode';
import { dockerExec } from './dockerExec.js';
import type { HistoryOp } from '../../shared/types.js';

export type ParsedOpResult =
  | { kind: 'complete'; sha: string }
  | { kind: 'conflict-detected'; message: string }
  | { kind: 'gh-error'; message: string };

export function parseHistoryOpResult(stdout: string, exitCode: number): ParsedOpResult {
  const lines = stdout.trim().split('\n').filter((l) => l.startsWith('{') && l.endsWith('}'));
  const last = lines.at(-1);
  if (!last) {
    return { kind: 'gh-error', message: `exit code ${exitCode}` };
  }
  try {
    const obj = JSON.parse(last) as { ok?: boolean; sha?: string; reason?: string; message?: string };
    if (obj.ok && typeof obj.sha === 'string') return { kind: 'complete', sha: obj.sha };
    if (obj.reason === 'conflict') return { kind: 'conflict-detected', message: obj.message ?? '' };
    return { kind: 'gh-error', message: obj.message ?? obj.reason ?? 'unknown' };
  } catch {
    return { kind: 'gh-error', message: `unparseable output: ${last.slice(0, 120)}` };
  }
}

export interface HistoryOpEnv {
  FBI_OP: string;
  FBI_BRANCH: string;
  FBI_DEFAULT: string;
  FBI_STRATEGY?: string;
  FBI_SUBJECT?: string;
  FBI_RUN_ID?: string;
}

export function buildEnv(runId: number, branch: string, defaultBranch: string, op: HistoryOp): HistoryOpEnv {
  const env: HistoryOpEnv = {
    FBI_OP: op.op,
    FBI_BRANCH: branch,
    FBI_DEFAULT: defaultBranch,
    FBI_RUN_ID: String(runId),
  };
  if (op.op === 'merge') env.FBI_STRATEGY = op.strategy ?? 'merge';
  if (op.op === 'merge' && op.strategy === 'squash') {
    env.FBI_SUBJECT = `Merge branch '${branch}' (FBI run #${runId})`;
  }
  if (op.op === 'squash-local') env.FBI_SUBJECT = op.subject;
  return env;
}

export async function runHistoryOpInContainer(
  container: Docker.Container,
  env: HistoryOpEnv,
  opts: { timeoutMs?: number } = {},
): Promise<ParsedOpResult> {
  const { stdout, exitCode } = await dockerExec(
    container,
    ['/usr/local/bin/fbi-history-op.sh'],
    {
      timeoutMs: opts.timeoutMs ?? 60_000,
      env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    },
  );
  return parseHistoryOpResult(stdout, exitCode);
}
