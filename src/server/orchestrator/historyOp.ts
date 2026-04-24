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
  FBI_PATH?: string;
  FBI_BASE_BRANCH?: string;
}

export function buildEnv(runId: number, branch: string, defaultBranch: string, op: HistoryOp, baseBranch?: string | null): HistoryOpEnv {
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
  if (op.op === 'push-submodule') env.FBI_PATH = op.path;
  if (op.op === 'mirror-rebase' && baseBranch) env.FBI_BASE_BRANCH = baseBranch;
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

export interface TransientOpInput {
  docker: Docker;
  image: string;
  repoUrl: string;
  historyOpScriptPath: string;
  env: HistoryOpEnv;
  sshSocket: string;
  authorName: string;
  authorEmail: string;
  timeoutMs?: number;
}

export async function runHistoryOpInTransientContainer(
  input: TransientOpInput,
): Promise<ParsedOpResult> {
  const { docker, image, repoUrl, historyOpScriptPath, env, sshSocket,
    authorName, authorEmail, timeoutMs = 120_000 } = input;
  const name = `fbi-history-${env.FBI_RUN_ID ?? 'x'}-${Date.now()}`;
  const envList = [
    `REPO_URL=${repoUrl}`,
    `GIT_AUTHOR_NAME=${authorName}`,
    `GIT_AUTHOR_EMAIL=${authorEmail}`,
    `SSH_AUTH_SOCK=/ssh-agent`,
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
  ];
  // Container does: clone repo into /workspace, configure git user, then run
  // the history op script.
  const cmd = [
    '/bin/sh', '-c',
    [
      'set -e',
      'cd /workspace',
      'git clone --quiet "$REPO_URL" . >/dev/null 2>&1',
      'git config user.name  "$GIT_AUTHOR_NAME"',
      'git config user.email "$GIT_AUTHOR_EMAIL"',
      '/usr/local/bin/fbi-history-op.sh',
    ].join('; '),
  ];
  const container = await docker.createContainer({
    Image: image,
    name,
    User: 'root',
    Env: envList,
    Cmd: cmd,
    Tty: false,
    HostConfig: {
      AutoRemove: false,
      Binds: [
        `${sshSocket}:/ssh-agent`,
        `${historyOpScriptPath}:/usr/local/bin/fbi-history-op.sh:ro`,
      ],
    },
    WorkingDir: '/workspace',
  });

  const timer = setTimeout(() => { container.kill().catch(() => { /* */ }); }, timeoutMs);
  try {
    await container.start();
    const logsStream = await container.logs({
      follow: true, stdout: true, stderr: true,
    }) as unknown as NodeJS.ReadableStream;
    const outChunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      let buf: Buffer = Buffer.alloc(0);
      logsStream.on('data', (d: Buffer) => {
        buf = buf.length === 0 ? Buffer.from(d) : Buffer.concat([buf, d]);
        while (buf.length >= 8) {
          const kind = buf[0];
          const size = buf.readUInt32BE(4);
          if (buf.length < 8 + size) break;
          const payload = Buffer.from(buf.subarray(8, 8 + size));
          if (kind === 1) outChunks.push(payload);
          buf = Buffer.from(buf.subarray(8 + size));
        }
      });
      logsStream.on('end', () => resolve());
      logsStream.on('error', reject);
    });
    const result = await container.wait();
    return parseHistoryOpResult(Buffer.concat(outChunks).toString('utf8'), result.StatusCode ?? -1);
  } finally {
    clearTimeout(timer);
    await container.remove({ force: true, v: true }).catch(() => { /* */ });
  }
}
