import type { DB } from './index.js';
import type { McpServer } from '../../shared/types.js';

interface McpServerRow {
  id: number;
  project_id: number | null;
  name: string;
  type: 'stdio' | 'sse';
  command: string | null;
  args_json: string;
  url: string | null;
  env_json: string;
  created_at: number;
}

function parseArgs(json: string): string[] {
  const v = JSON.parse(json) as unknown;
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function parseEnv(json: string): Record<string, string> {
  const v = JSON.parse(json) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function fromRow(row: McpServerRow): McpServer {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    type: row.type,
    command: row.command,
    args: parseArgs(row.args_json),
    url: row.url,
    env: parseEnv(row.env_json),
    created_at: row.created_at,
  };
}

export interface CreateMcpServerInput {
  project_id: number | null;
  name: string;
  type: 'stdio' | 'sse';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
}

export class McpServersRepo {
  constructor(private db: DB) {}

  listGlobal(): McpServer[] {
    return (
      this.db
        .prepare('SELECT * FROM mcp_servers WHERE project_id IS NULL ORDER BY name')
        .all() as McpServerRow[]
    ).map(fromRow);
  }

  listForProject(projectId: number): McpServer[] {
    return (
      this.db
        .prepare('SELECT * FROM mcp_servers WHERE project_id = ? ORDER BY name')
        .all(projectId) as McpServerRow[]
    ).map(fromRow);
  }

  listEffective(projectId: number): McpServer[] {
    const map = new Map<string, McpServer>();
    for (const s of this.listGlobal()) map.set(s.name, s);
    for (const s of this.listForProject(projectId)) map.set(s.name, s);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: number): McpServer | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id) as McpServerRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(input: CreateMcpServerInput): McpServer {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO mcp_servers (project_id, name, type, command, args_json, url, env_json, created_at)
         VALUES (@project_id, @name, @type, @command, @args_json, @url, @env_json, @created_at)`
      )
      .run({
        project_id: input.project_id ?? null,
        name: input.name,
        type: input.type,
        command: input.command ?? null,
        args_json: JSON.stringify(input.args ?? []),
        url: input.url ?? null,
        env_json: JSON.stringify(input.env ?? {}),
        created_at: now,
      });
    return fromRow(
      this.db
        .prepare('SELECT * FROM mcp_servers WHERE id = ?')
        .get(result.lastInsertRowid) as McpServerRow
    );
  }

  update(
    id: number,
    patch: Partial<Omit<CreateMcpServerInput, 'project_id'>>
  ): McpServer | null {
    const existing = this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id) as McpServerRow | undefined;
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE mcp_servers
         SET name=@name, type=@type, command=@command, args_json=@args_json, url=@url, env_json=@env_json
         WHERE id=@id`
      )
      .run({
        id,
        name: patch.name ?? existing.name,
        type: patch.type ?? existing.type,
        command: patch.command !== undefined ? patch.command : existing.command,
        args_json: patch.args !== undefined ? JSON.stringify(patch.args) : existing.args_json,
        url: patch.url !== undefined ? patch.url : existing.url,
        env_json: patch.env !== undefined ? JSON.stringify(patch.env) : existing.env_json,
      });
    return fromRow(
      this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow
    );
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }
}
