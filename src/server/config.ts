import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Look up the host system's "docker" group GID from /etc/group. Used to give
// the in-container agent user supplementary group membership matching the
// owner of the forwarded docker socket — otherwise `docker` calls from inside
// the run container hit EACCES on /var/run/docker.sock.
function lookupHostDockerGid(): number | null {
  try {
    const text = fs.readFileSync('/etc/group', 'utf8');
    for (const line of text.split('\n')) {
      const [name, , gidStr] = line.split(':');
      if (name === 'docker') {
        const n = Number.parseInt(gidStr ?? '', 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch { /* /etc/group unreadable — leave unset */ }
  return null;
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  runsDir: string;
  // Bind-mount source prefix used when passing runsDir-derived paths to the
  // Docker daemon. For a normal install this equals runsDir. For dev-in-
  // container setups where the daemon sees a different path than the server
  // process, set FBI_HOST_RUNS_DIR to the daemon's view. Optional — consumers
  // fall back to runsDir when undefined.
  hostRunsDir?: string;
  draftUploadsDir: string;
  hostSshAuthSock: string;
  // Bind-mount source for the ssh-agent socket. Defaults to hostSshAuthSock;
  // override with FBI_HOST_BIND_SSH_AUTH_SOCK for dev-in-container setups.
  hostBindSshAuthSock?: string;
  hostClaudeDir: string;
  // Bind-mount source prefix used when passing hostClaudeDir-derived paths
  // to the Docker daemon. Defaults to hostClaudeDir; override with
  // FBI_HOST_BIND_CLAUDE_DIR for dev-in-container setups.
  hostBindClaudeDir?: string;
  hostDockerSocket: string;
  hostDockerGid: number | null;
  secretsKeyFile: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  webDir: string;
  cliDistDir: string;
  quanticoEnabled: boolean;
  quanticoBinaryPath: string;
  mockSpeedMult: number;
  limitMonitorIdleMs: number;
  limitMonitorWarmupMs: number;
  containerMemMb: number;
  containerCpus: number;
  containerPids: number;
}

function parseList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    dbPath: process.env.DB_PATH ?? '/var/lib/agent-manager/db.sqlite',
    runsDir: process.env.RUNS_DIR ?? '/var/lib/agent-manager/runs',
    hostRunsDir: process.env.FBI_HOST_RUNS_DIR,
    draftUploadsDir:
      process.env.DRAFT_UPLOADS_DIR ?? '/var/lib/agent-manager/draft-uploads',
    hostSshAuthSock: process.env.HOST_SSH_AUTH_SOCK ?? process.env.SSH_AUTH_SOCK ?? '',
    hostBindSshAuthSock: process.env.FBI_HOST_BIND_SSH_AUTH_SOCK,
    hostClaudeDir: process.env.HOST_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
    hostBindClaudeDir: process.env.FBI_HOST_BIND_CLAUDE_DIR,
    hostDockerSocket: process.env.HOST_DOCKER_SOCKET ?? '/var/run/docker.sock',
    hostDockerGid: (() => {
      const override = process.env.HOST_DOCKER_GID;
      if (override) {
        const n = Number.parseInt(override, 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
      }
      return lookupHostDockerGid();
    })(),
    secretsKeyFile: process.env.SECRETS_KEY_FILE ?? '/etc/agent-manager/secrets.key',
    gitAuthorName: required('GIT_AUTHOR_NAME'),
    gitAuthorEmail: required('GIT_AUTHOR_EMAIL'),
    webDir: process.env.WEB_DIR ?? path.resolve('dist/web'),
    cliDistDir: process.env.CLI_DIST_DIR ?? path.resolve('dist/cli'),
    quanticoEnabled: process.env.FBI_QUANTICO_ENABLED === '1',
    quanticoBinaryPath: process.env.FBI_QUANTICO_BINARY_PATH ?? '/usr/local/lib/fbi/quantico',
    mockSpeedMult: Number(process.env.MOCK_CLAUDE_SPEED_MULT ?? 1.0),
    limitMonitorIdleMs: Number(process.env.FBI_LIMIT_MONITOR_IDLE_MS ?? 15_000),
    limitMonitorWarmupMs: Number(process.env.FBI_LIMIT_MONITOR_WARMUP_MS ?? 60_000),
    containerMemMb: Number(process.env.FBI_CONTAINER_MEM_MB ?? 4096),
    containerCpus: Number(process.env.FBI_CONTAINER_CPUS ?? 2),
    containerPids: Number(process.env.FBI_CONTAINER_PIDS ?? 4096),
  };
}

// Kept for startup migration only — not part of Config.
export function legacyDefaultLists(): { marketplaces: string[]; plugins: string[] } {
  return {
    marketplaces: parseList(process.env.FBI_DEFAULT_MARKETPLACES),
    plugins: parseList(process.env.FBI_DEFAULT_PLUGINS),
  };
}
