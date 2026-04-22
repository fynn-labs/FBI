import os from 'node:os';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export interface Config {
  port: number;
  dbPath: string;
  runsDir: string;
  hostSshAuthSock: string;
  hostClaudeDir: string;
  secretsKeyFile: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  webDir: string;
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
    hostSshAuthSock: process.env.HOST_SSH_AUTH_SOCK ?? process.env.SSH_AUTH_SOCK ?? '',
    hostClaudeDir: process.env.HOST_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
    secretsKeyFile: process.env.SECRETS_KEY_FILE ?? '/etc/agent-manager/secrets.key',
    gitAuthorName: required('GIT_AUTHOR_NAME'),
    gitAuthorEmail: required('GIT_AUTHOR_EMAIL'),
    webDir: process.env.WEB_DIR ?? path.resolve('dist/web'),
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
