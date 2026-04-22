import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '../../shared/types.js';

type McpEntry =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; env?: Record<string, string> };

export function buildMcpServersConfig(
  mcps: McpServer[],
  secrets: Record<string, string>,
): Record<string, McpEntry> {
  const result: Record<string, McpEntry> = {};
  for (const mcp of mcps) {
    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(mcp.env)) {
      resolvedEnv[k] = v.startsWith('$') ? (secrets[v.slice(1)] ?? '') : v;
    }
    const env = Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined;
    if (mcp.type === 'stdio') {
      // default command matches Claude Code's built-in MCP runner
      result[mcp.name] = { type: 'stdio', command: mcp.command ?? 'npx', args: mcp.args, ...(env ? { env } : {}) };
    } else {
      if (!mcp.url) continue;
      result[mcp.name] = { type: 'sse', url: mcp.url, ...(env ? { env } : {}) };
    }
  }
  return result;
}

// Reads the host's ~/.claude.json, strips fields that would leak host install
// details into the container, seeds trust for /workspace, and injects MCP server
// config so Claude can reach the configured MCP servers. Always returns a string.
export function buildContainerClaudeJson(
  hostClaudeDir: string,
  mcps: McpServer[],
  secrets: Record<string, string>,
): string {
  let obj: Record<string, unknown> = {};
  const hostJson = path.join(path.dirname(hostClaudeDir), '.claude.json');
  if (fs.existsSync(hostJson)) {
    try {
      obj = JSON.parse(fs.readFileSync(hostJson, 'utf8')) as Record<string, unknown>;
    } catch { /* fall through with empty obj */ }
  }
  delete obj.installMethod;
  delete obj.autoUpdates;

  const projects = (obj.projects as Record<string, Record<string, unknown>>) ?? {};
  projects['/workspace'] = {
    ...(projects['/workspace'] ?? {}),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    projectOnboardingSeenCount: 1,
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
  };
  obj.projects = projects;

  const mcpConfig = buildMcpServersConfig(mcps, secrets);
  if (Object.keys(mcpConfig).length > 0) obj.mcpServers = mcpConfig;

  return JSON.stringify(obj);
}
