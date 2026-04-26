import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContainerSpec } from './index.js';

const tmpQuantico = path.join(os.tmpdir(), `quantico-bindspec-${Date.now()}`);
// A temp dir that acts as the host claude dir — we put .credentials.json in it
// so claudeAuthMounts returns a real bind entry for the mock=0 test.
const tmpClaudeDir = path.join(os.tmpdir(), `claude-bindspec-${Date.now()}`);

beforeAll(() => {
  // Pre-flight requires the binary to exist on disk.
  fs.writeFileSync(tmpQuantico, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Provide a fake credentials file so claudeAuthMounts returns a bind entry.
  fs.mkdirSync(tmpClaudeDir, { recursive: true });
  fs.writeFileSync(path.join(tmpClaudeDir, '.credentials.json'), '{}');
});

function baseInput(overrides: Partial<Parameters<typeof buildContainerSpec>[0]> = {}) {
  return {
    runId: 42,
    run: { mock: 0 as 0 | 1, mock_scenario: null as string | null, branch_name: 'feat/x' },
    project: { repo_url: 'git@example:o/r.git', default_branch: 'main' },
    authorName: 'A', authorEmail: 'a@example.com',
    marketplaces: [], plugins: [],
    resumeSessionId: null,
    authEnv: {},
    authMounts: [],
    projectSecrets: {},
    modelParamEnv: [],
    imageTag: 'fbi:test',
    scriptsDir: '/tmp/scripts',
    mountDir: '/tmp/mount',
    stateDir: '/tmp/state',
    uploadsDir: '/tmp/uploads',
    safeguardBind: '/tmp/safe:/safeguard:rw',
    toBindHost: (p: string) => p,
    hostClaudeDir: tmpClaudeDir,
    hostBindClaudeDir: tmpClaudeDir,
    hostDockerSocket: '/var/run/docker.sock',
    hostDockerGid: null,
    memMb: 512, cpus: 1, pids: 256,
    containerName: 'test-container',
    quanticoBinaryPath: tmpQuantico,
    mockSpeedMult: 10,
    ...overrides,
  };
}

describe('buildContainerSpec', () => {
  it('mock=1 binds Quantico over /usr/local/bin/claude and skips OAuth bind', () => {
    const spec = buildContainerSpec(baseInput({
      run: { mock: 1, mock_scenario: 'limit-breach', branch_name: 'feat/x' },
    }));
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds).toContain(`${tmpQuantico}:/usr/local/bin/claude:ro`);
    expect(binds.some((b) => b.includes('.claude.json') || b.endsWith('/.claude:ro'))).toBe(false);
    const env = spec.Env ?? [];
    expect(env).toContain('MOCK_CLAUDE_SCENARIO=limit-breach');
    expect(env.some((e) => e.startsWith('MOCK_CLAUDE_SPEED_MULT='))).toBe(true);
  });

  it('mock=0 leaves the bind list unchanged (no Quantico, OAuth bind present)', () => {
    const spec = buildContainerSpec(baseInput());
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.includes('quantico'))).toBe(false);
    // claudeAuthMounts should be in there (verify by looking for the .claude path)
    expect(binds.some((b) => b.includes(tmpClaudeDir))).toBe(true);
  });

  it('mock=1 falls back to "default" scenario name when mock_scenario is null', () => {
    const spec = buildContainerSpec(baseInput({
      run: { mock: 1, mock_scenario: null, branch_name: 'feat/x' },
    }));
    expect(spec.Env).toContain('MOCK_CLAUDE_SCENARIO=default');
  });

  it('mock=1 throws if the Quantico binary does not exist', () => {
    expect(() => buildContainerSpec(baseInput({
      run: { mock: 1, mock_scenario: 'default', branch_name: 'feat/x' },
      quanticoBinaryPath: '/no/such/path/quantico',
    }))).toThrow(/quantico binary not found/);
  });
});
