import type { McpServer, Project, Run, SecretName, Settings } from '@shared/types.js';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init?.body != null ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON but got ${contentType}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

type McpServerInput = {
  name: string;
  type: 'stdio' | 'sse';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
};

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: number) => request<Project>(`/api/projects/${id}`),
  createProject: (body: Omit<Project, 'id' | 'created_at' | 'updated_at'>) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: number, patch: Partial<Omit<Project, 'id' | 'created_at' | 'updated_at'>>) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  listSecrets: (projectId: number) =>
    request<SecretName[]>(`/api/projects/${projectId}/secrets`),
  upsertSecret: (projectId: number, name: string, value: string) =>
    request<void>(`/api/projects/${projectId}/secrets/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  removeSecret: (projectId: number, name: string) =>
    request<void>(`/api/projects/${projectId}/secrets/${name}`, { method: 'DELETE' }),

  listRuns: (state?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled') =>
    request<Run[]>(state ? `/api/runs?state=${state}` : '/api/runs'),
  listProjectRuns: (projectId: number) =>
    request<Run[]>(`/api/projects/${projectId}/runs`),
  getRun: (id: number) => request<Run>(`/api/runs/${id}`),
  getRecentPrompts: (projectId: number, limit = 10) =>
    request<{ prompt: string; last_used_at: number; run_id: number }[]>(
      `/api/projects/${projectId}/prompts/recent?limit=${limit}`
    ),
  createRun: (projectId: number, prompt: string, branch?: string) =>
    request<Run>(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        branch: branch && branch.trim() !== '' ? branch.trim() : undefined,
      }),
    }),
  deleteRun: (id: number) => request<void>(`/api/runs/${id}`, { method: 'DELETE' }),

  getSettings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
    global_marketplaces?: string[];
    global_plugins?: string[];
  }) => request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  // Global MCP servers
  listMcpServers: () => request<McpServer[]>('/api/mcp-servers'),
  createMcpServer: (input: McpServerInput) =>
    request<McpServer>('/api/mcp-servers', { method: 'POST', body: JSON.stringify(input) }),
  updateMcpServer: (id: number, patch: Partial<McpServerInput>) =>
    request<McpServer>(`/api/mcp-servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMcpServer: (id: number) =>
    request<void>(`/api/mcp-servers/${id}`, { method: 'DELETE' }),

  // Per-project MCP servers
  listProjectMcpServers: (projectId: number) =>
    request<McpServer[]>(`/api/projects/${projectId}/mcp-servers`),
  createProjectMcpServer: (projectId: number, input: McpServerInput) =>
    request<McpServer>(`/api/projects/${projectId}/mcp-servers`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProjectMcpServer: (projectId: number, serverId: number, patch: Partial<McpServerInput>) =>
    request<McpServer>(`/api/projects/${projectId}/mcp-servers/${serverId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteProjectMcpServer: (projectId: number, serverId: number) =>
    request<void>(`/api/projects/${projectId}/mcp-servers/${serverId}`, { method: 'DELETE' }),
};
