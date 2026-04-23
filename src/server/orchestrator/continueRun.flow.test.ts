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
import { runMountDir, runUploadsDir } from './sessionId.js';
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

interface ContainerCapture {
  createdEnv: string[][];
}

function makeSuccessContainer(): Docker.Container {
  const attachStream = new PassThrough();
  let resultTar: NodeJS.ReadableStream | undefined;
  return {
    id: 'continue-container',
    putArchive: async () => {},
    attach: async () => attachStream,
    start: async () => {
      resultTar = await makeResultTar(0, 0, 'cafe', 'feat/keep-going');
      attachStream.push(Buffer.from('[fbi] run succeeded\n'));
      attachStream.push(null);
    },
    wait: async () => ({ StatusCode: 0 }),
    inspect: async () => ({ State: { OOMKilled: false } }),
    getArchive: async () => resultTar!,
    remove: async () => {},
  } as unknown as Docker.Container;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-cont-'));
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
  const config: Config = {
    port: 0, dbPath: path.join(dir, 'db.sqlite'), runsDir: dir,
    containerMemMb: 512, containerCpus: 1, containerPids: 100,
    hostSshAuthSock: '', gitAuthorName: 'T', gitAuthorEmail: 't@t',
    hostClaudeDir: dir, secretsKeyFile: path.join(dir, 'k'), webDir: dir,
  } as unknown as Config;
  return {
    dir, runs, projects, settings, p, streams,
    makeOrchestrator: (docker: Docker) => new Orchestrator({
      docker, config, projects, runs, secrets, settings, mcpServers, streams, rateLimitState, usage,
      poller: { nudge: async () => {} },
    }),
  };
}

describe('Orchestrator.continueRun', () => {
  it('revives a failed run with a captured session and transitions failed → running → succeeded', async () => {
    const { dir, runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'keep going',
      branch_hint: 'feat/keep-going',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `cont-${id}.log`),
    });
    // Walk the run through a full failure cycle.
    runs.markStarted(run.id, 'c1');
    runs.setClaudeSessionId(run.id, 'sess-xyz');
    runs.markFinished(run.id, { state: 'failed', error: 'OOM' });
    // Plant the session JSONL on disk so eligibility passes.
    const sessDir = runMountDir(dir, run.id);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'sess-xyz.jsonl'), '{"x":1}\n');

    const capture: ContainerCapture = { createdEnv: [] };
    const mockDocker = {
      createContainer: vi.fn().mockImplementation(async (spec: { Env: string[] }) => {
        capture.createdEnv.push(spec.Env);
        return makeSuccessContainer();
      }),
    } as unknown as Docker;

    const orch = makeOrchestrator(mockDocker);
    await orch.continueRun(run.id);

    const final = runs.get(run.id)!;
    expect(final.state).toBe('succeeded');
    expect(final.resume_attempts).toBe(0);
    expect(final.error).toBeNull();
    // The env passed to createContainer must carry both the session id and branch name.
    const env = capture.createdEnv[0];
    expect(env).toContain('FBI_RESUME_SESSION_ID=sess-xyz');
    expect(env).toContain('FBI_CHECKOUT_BRANCH=feat/keep-going');

    const createArgs = mockDocker.createContainer.mock.calls[0][0];
    const binds = createArgs.HostConfig.Binds as string[];
    expect(binds).toContainEqual(`${runUploadsDir(dir, run.id)}:/fbi/uploads:ro`);
  });

  it('rejects a run without a captured session id', async () => {
    const { runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `cont-${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.markFinished(run.id, { state: 'failed' });
    const orch = makeOrchestrator({ createContainer: vi.fn() } as unknown as Docker);
    await expect(orch.continueRun(run.id)).rejects.toThrow(/no_session/);
  });

  it('revives a succeeded run (continuation is allowed after success)', async () => {
    const { dir, runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      branch_hint: 'feat/done',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `cont-${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.setClaudeSessionId(run.id, 'sess-ok');
    runs.markFinished(run.id, { state: 'succeeded' });
    const sessDir = runMountDir(dir, run.id);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'sess-ok.jsonl'), '{"x":1}\n');

    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(makeSuccessContainer()),
    } as unknown as Docker;
    const orch = makeOrchestrator(mockDocker);
    await orch.continueRun(run.id);
    expect(runs.get(run.id)!.state).toBe('succeeded');
  });

  it('rejects a queued run (only terminated runs can be continued)', async () => {
    const { runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `cont-${id}.log`),
    });
    const orch = makeOrchestrator({ createContainer: vi.fn() } as unknown as Docker);
    await expect(orch.continueRun(run.id)).rejects.toThrow(/wrong_state/);
  });
});
