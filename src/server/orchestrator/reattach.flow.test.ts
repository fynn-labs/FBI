import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Docker from 'dockerode';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { SecretsRepo } from '../db/secrets.js';
import { SettingsRepo } from '../db/settings.js';
import { McpServersRepo } from '../db/mcpServers.js';
import { RateLimitStateRepo } from '../db/rateLimitState.js';
import { UsageRepo } from '../db/usage.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { Orchestrator } from './index.js';
import { runMountDir } from './sessionId.js';
import type { Config } from '../config.js';

vi.mock('./image.js', () => ({
  ImageBuilder: class { async resolve() { return 'stub:latest'; } },
  ALWAYS: [], POSTBUILD: '',
}));
vi.mock('./gitAuth.js', () => ({
  SshAgentForwarding: class { describe() { return 'stub'; } mounts() { return []; } env() { return {}; } },
}));

function makeReattachContainer(): Docker.Container {
  const attachStream = new PassThrough();
  const logsStream = new PassThrough();
  setImmediate(() => { logsStream.push(null); });
  return {
    id: 'old-container',
    inspect: async () => ({ State: { OOMKilled: false } }),
    attach: async () => attachStream,
    logs: async () => logsStream,
    wait: async () => ({ StatusCode: 0 }),
    getArchive: async () => { throw new Error('no result'); },
    remove: async () => {},
  } as unknown as Docker.Container;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-reattach-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const secrets = new SecretsRepo(db, Buffer.alloc(32));
  const settings = new SettingsRepo(db);
  const mcpServers = new McpServersRepo(db);
  const rateLimitState = new RateLimitStateRepo(db);
  const usage = new UsageRepo(db);
  const streams = new RunStreamRegistry();
  const p = projects.create({
    name: 't', repo_url: 'git@example:o/r.git', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const config = {
    port: 0, dbPath: path.join(dir, 'db.sqlite'), runsDir: dir,
    containerMemMb: 512, containerCpus: 1, containerPids: 100,
    hostSshAuthSock: '', gitAuthorName: 'T', gitAuthorEmail: 't@t',
    hostClaudeDir: dir, secretsKeyFile: path.join(dir, 'k'), webDir: dir,
  } as unknown as Config;
  return {
    dir, runs, p,
    makeOrchestrator: (docker: Docker) => new Orchestrator({
      docker, config, projects, runs, secrets, settings, mcpServers, streams, rateLimitState, usage,
      poller: { nudge: async () => {} },
    }),
  };
}

describe('Orchestrator.recover -> reattach', () => {
  it('captures claude_session_id from the mount dir after the container exits', async () => {
    const { dir, runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'long-lived',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `reattach-${id}.log`),
    });
    runs.markStarted(run.id, 'old-container');
    // Claude wrote a session JSONL into the mount dir before the server
    // restart. scanSessionId() walks one level deep and expects a UUID-named
    // file (matching Claude Code's on-disk layout: `<mount>/<project>/<uuid>.jsonl`).
    const sessDir = path.join(runMountDir(dir, run.id), '-workspace');
    fs.mkdirSync(sessDir, { recursive: true });
    const sessionId = 'deadbeef-1234-4567-8901-abcdefabcdef';
    fs.writeFileSync(path.join(sessDir, `${sessionId}.jsonl`), '{"x":1}\n');

    const container = makeReattachContainer();
    const mockDocker = {
      getContainer: vi.fn().mockReturnValue(container),
    } as unknown as Docker;

    const orch = makeOrchestrator(mockDocker);
    await orch.recover();
    // recover fires reattach in the background; wait for the run to finish.
    for (let i = 0; i < 50; i++) {
      const r = runs.get(run.id)!;
      if (r.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const final = runs.get(run.id)!;
    expect(final.state).not.toBe('running'); // reattach completed
    expect(final.claude_session_id).toBe(sessionId);
  });
});
