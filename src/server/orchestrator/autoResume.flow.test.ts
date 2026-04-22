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
import { RunStreamRegistry } from '../logs/registry.js';
import { Orchestrator } from './index.js';
import type { Config } from '../config.js';

vi.mock('./image.js', () => ({
  ImageBuilder: class { async resolve() { return 'stub:latest'; } },
  ALWAYS: [],
  POSTBUILD: '',
}));

vi.mock('./gitAuth.js', () => ({
  SshAgentForwarding: class {
    describe() { return 'stub-auth'; }
    mounts() { return []; }
    env() { return {}; }
  },
}));

async function makeResultTar(
  exitCode: number, pushExit: number, headSha: string, branch: string,
): Promise<NodeJS.ReadableStream> {
  const tarStream = await import('tar-stream');
  const pack = tarStream.pack();
  const content = JSON.stringify({ exit_code: exitCode, push_exit: pushExit, head_sha: headSha, branch });
  pack.entry({ name: 'result.json' }, content);
  pack.finalize();
  return pack as unknown as NodeJS.ReadableStream;
}

function makeRateLimitContainer(logBytes: Buffer): Docker.Container {
  const attachStream = new PassThrough();
  return {
    id: 'rate-limit-container',
    putArchive: async () => {},
    attach: async () => attachStream,
    // Push data synchronously so it is in the log file before container.wait() resolves.
    start: async () => {
      attachStream.push(logBytes);
      attachStream.push(null);
    },
    wait: async () => ({ StatusCode: 1 }),
    inspect: async () => ({ State: { OOMKilled: false } }),
    getArchive: async () => { throw new Error('no result file in rate-limit container'); },
    remove: async () => {},
  } as unknown as Docker.Container;
}

function makeSuccessContainer(exitCode = 0, pushExit = 0): Docker.Container {
  const attachStream = new PassThrough();
  let resultTar: NodeJS.ReadableStream | undefined;
  return {
    id: 'success-container',
    putArchive: async () => {},
    attach: async () => attachStream,
    start: async () => {
      resultTar = await makeResultTar(exitCode, pushExit, 'deadbeef', 'feat/fix');
      attachStream.push(Buffer.from(`[fbi] run ${exitCode === 0 ? 'succeeded' : 'failed'}\n`));
      attachStream.push(null);
    },
    wait: async () => ({ StatusCode: exitCode }),
    inspect: async () => ({ State: { OOMKilled: false } }),
    getArchive: async () => {
      if (!resultTar) throw new Error('getArchive called before start()');
      return resultTar;
    },
    remove: async () => {},
  } as unknown as Docker.Container;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-flow-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const secrets = new SecretsRepo(db, Buffer.alloc(32));
  const settings = new SettingsRepo(db);
  const mcpServers = new McpServersRepo(db);
  const rateLimitState = new RateLimitStateRepo(db);
  const streams = new RunStreamRegistry();

  const p = projects.create({
    name: 'test', repo_url: 'git@github.com:org/repo.git', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });

  const config: Config = {
    port: 3000,
    dbPath: path.join(dir, 'db.sqlite'),
    runsDir: dir,
    containerMemMb: 512,
    containerCpus: 1,
    containerPids: 100,
    hostSshAuthSock: '',   // empty: fetchDevcontainerFile returns null immediately; SshAgentForwarding is mocked
    gitAuthorName: 'Test',
    gitAuthorEmail: 'test@test.com',
    hostClaudeDir: dir,
    secretsKeyFile: path.join(dir, 'secrets.key'),
    webDir: dir,
  } as unknown as Config;

  return {
    dir, runs, projects, settings, p, streams,
    makeOrchestrator: (docker: Docker) => new Orchestrator({
      docker, config, projects, runs, secrets, settings, mcpServers, streams, rateLimitState,
    }),
  };
}

describe('autoResume flow (stubbed Docker)', () => {
  it('launch: rate-limit exit transitions run to awaiting_resume', async () => {
    const { runs, p, settings, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'fix tests',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `flow-${id}.log`),
    });

    // Ensure auto-resume is enabled (default is 1, but make it explicit).
    settings.update({ auto_resume_enabled: true });

    // Use an epoch 1 hour in the future so classify() returns a valid reset_at.
    const futureEpochSecs = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    const rateLimitLog = Buffer.from(`Claude usage limit reached|${futureEpochSecs}\n`);
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(makeRateLimitContainer(rateLimitLog)),
    } as unknown as Docker;

    const orch = makeOrchestrator(mockDocker);

    await orch.launch(run.id);

    const updated = runs.get(run.id)!;
    expect(updated.state).toBe('awaiting_resume');
    expect(updated.next_resume_at).not.toBeNull();
    expect(updated.resume_attempts).toBe(1);
  });

  it('resume: success exit transitions run from awaiting_resume to succeeded', async () => {
    const { runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'fix tests',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `flow-resume-${id}.log`),
    });

    // Put run directly in awaiting_resume state.
    runs.markStarted(run.id, 'old-container');
    runs.markAwaitingResume(run.id, {
      next_resume_at: Date.now() + 60_000,
      last_limit_reset_at: Date.now(),
    });

    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(makeSuccessContainer(0, 0)),
    } as unknown as Docker;

    const orch = makeOrchestrator(mockDocker);

    await orch.resume(run.id);

    const final = runs.get(run.id)!;
    expect(final.state).toBe('succeeded');
  });
});
