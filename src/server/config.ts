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
  dbPath: string;
  runsDir: string;
  draftUploadsDir: string;
  hostSshAuthSock: string;
  hostClaudeDir: string;
  hostDockerSocket: string;
  hostDockerGid: number | null;
  secretsKeyFile: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  webDir: string;
  cliDistDir: string;
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
    dbPath: process.env.DB_PATH ?? '/var/lib/agent-manager/db.sqlite',
    runsDir: process.env.RUNS_DIR ?? '/var/lib/agent-manager/runs',
    draftUploadsDir:
      process.env.DRAFT_UPLOADS_DIR ?? '/var/lib/agent-manager/draft-uploads',
    hostSshAuthSock: process.env.HOST_SSH_AUTH_SOCK ?? process.env.SSH_AUTH_SOCK ?? '',
    hostClaudeDir: process.env.HOST_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
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
