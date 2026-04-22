import { describe, it, expect } from 'vitest';
import { buildMcpServersConfig, buildContainerClaudeJson } from './claudeJson.js';
import type { McpServer } from '../../shared/types.js';

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 1,
    project_id: null,
    name: 'test',
    type: 'stdio',
    command: 'npx',
    args: [],
    url: null,
    env: {},
    created_at: 0,
    ...overrides,
  };
}

describe('buildMcpServersConfig', () => {
  it('produces stdio entry with command and args', () => {
    const result = buildMcpServersConfig(
      [makeServer({ name: 'github', command: 'npx', args: ['-y', '@mcp/gh'] })],
      {}
    );
    expect(result.github).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', '@mcp/gh'] });
    expect((result.github as { env?: unknown }).env).toBeUndefined();
  });

  it('resolves $SECRET_NAME references', () => {
    const result = buildMcpServersConfig(
      [makeServer({ name: 'gh', env: { GITHUB_TOKEN: '$MY_TOKEN' } })],
      { MY_TOKEN: 'tok123' }
    );
    expect((result.gh as { env: Record<string, string> }).env).toEqual({ GITHUB_TOKEN: 'tok123' });
  });

  it('leaves literal env values unchanged', () => {
    const result = buildMcpServersConfig(
      [makeServer({ name: 'svc', env: { KEY: 'literal-value' } })],
      {}
    );
    expect((result.svc as { env: Record<string, string> }).env).toEqual({ KEY: 'literal-value' });
  });

  it('omits env key when env is empty', () => {
    const result = buildMcpServersConfig([makeServer()], {});
    expect('env' in result.test).toBe(false);
  });

  it('defaults command to npx when null', () => {
    const result = buildMcpServersConfig([makeServer({ command: null })], {});
    expect((result.test as { command: string }).command).toBe('npx');
  });

  it('skips SSE entries with null URL', () => {
    const result = buildMcpServersConfig(
      [makeServer({ name: 'bad-sse', type: 'sse', url: null })],
      {}
    );
    expect(result['bad-sse']).toBeUndefined();
  });

  it('produces SSE entry with url', () => {
    const result = buildMcpServersConfig(
      [makeServer({ name: 'my-sse', type: 'sse', url: 'https://example.com/sse' })],
      {}
    );
    expect(result['my-sse']).toMatchObject({ type: 'sse', url: 'https://example.com/sse' });
  });
});

describe('buildContainerClaudeJson', () => {
  it('always sets /workspace trust flags', () => {
    const json = buildContainerClaudeJson('/tmp/nonexistent/.claude', [], {});
    const obj = JSON.parse(json) as { projects: Record<string, unknown> };
    expect(obj.projects['/workspace']).toMatchObject({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('adds mcpServers when MCPs are configured', () => {
    const mcps = [makeServer({ name: 'fetch' })];
    const json = buildContainerClaudeJson('/tmp/nonexistent/.claude', mcps, {});
    const obj = JSON.parse(json) as { mcpServers?: Record<string, unknown> };
    expect(obj.mcpServers).toBeDefined();
    expect(obj.mcpServers!.fetch).toBeDefined();
  });

  it('does not add mcpServers when no MCPs configured', () => {
    const json = buildContainerClaudeJson('/tmp/nonexistent/.claude', [], {});
    const obj = JSON.parse(json) as { mcpServers?: unknown };
    expect(obj.mcpServers).toBeUndefined();
  });
});
