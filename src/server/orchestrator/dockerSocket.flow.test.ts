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

async function makeResultTar(): Promise<NodeJS.ReadableStream> {
  const tarStream = await import('tar-stream');
  const pack = tarStream.pack();
  const content = JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'deadbeef', branch: 'feat/x' });
  pack.entry({ name: 'result.json' }, content);
  pack.finalize();
  return pack as unknown as NodeJS.ReadableStream;
}

function makeSuccessContainer(): Docker.Container {
  const attachStream = new PassThrough();
  let resultTar: NodeJS.ReadableStream | undefined;
  return {
    id: 'ok-container',
    putArchive: async () => {},
    attach: async () => attachStream,
    start: async () => {
      resultTar = await makeResultTar();
      attachStream.push(Buffer.from('ok\n'));
      attachStream.push(null);
    },
    wait: async () => ({ StatusCode: 0 }),
    inspect: async () => ({ State: { OOMKilled: false } }),
    getArchive: async () => {
      if (!resultTar) throw new Error('getArchive called before start()');
      return resultTar;
    },
    remove: async () => {},
  } as unknown as Docker.Container;
}

function setup(configOverrides: Partial<Config>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-dsk-'));
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
    hostSshAuthSock: '',
    gitAuthorName: 'Test',
    gitAuthorEmail: 'test@test.com',
    hostClaudeDir: dir,
    hostDockerSocket: '',
    hostDockerGid: null,
    secretsKeyFile: path.join(dir, 'secrets.key'),
    webDir: dir,
    ...configOverrides,
  } as unknown as Config;

  return {
    dir, runs, projects, p,
    makeOrchestrator: (docker: Docker) => new Orchestrator({
      docker, config, projects, runs, secrets, settings, mcpServers, streams, rateLimitState, usage,
      poller: { nudge: async () => {} },
    }),
  };
}

describe('docker socket forwarding', () => {
  it('adds GroupAdd with host docker GID when configured', async () => {
    const { runs, p, makeOrchestrator } = setup({ hostDockerGid: 995 });
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `dsk-${id}.log`),
    });
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(makeSuccessContainer()),
    } as unknown as Docker;

    await makeOrchestrator(mockDocker).launch(run.id);

    const args = vi.mocked(mockDocker.createContainer).mock.calls[0][0];
    expect(args.HostConfig!.GroupAdd).toEqual(['995']);
  });

  it('omits GroupAdd when no docker GID is configured', async () => {
    const { runs, p, makeOrchestrator } = setup({ hostDockerGid: null });
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `dsk-${id}.log`),
    });
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(makeSuccessContainer()),
    } as unknown as Docker;

    await makeOrchestrator(mockDocker).launch(run.id);

    const args = vi.mocked(mockDocker.createContainer).mock.calls[0][0];
    expect(args.HostConfig!.GroupAdd).toBeUndefined();
  });

  it('bind-mounts the host docker socket when it exists', async () => {
    const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-sock-'));
    const sock = path.join(sockDir, 'docker.sock');
    fs.writeFileSync(sock, ''); // stand-in; fs.existsSync only checks existence

    const { runs, p, makeOrchestrator } = setup({ hostDockerSocket: sock });
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `dsk-${id}.log`),
    });
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(makeSuccessContainer()),
    } as unknown as Docker;

    await makeOrchestrator(mockDocker).launch(run.id);

    const args = vi.mocked(mockDocker.createContainer).mock.calls[0][0];
    const binds = args.HostConfig!.Binds as string[];
    expect(binds).toContain(`${sock}:/var/run/docker.sock`);
  });

  it('skips socket mount when the host socket path does not exist', async () => {
    const { runs, p, makeOrchestrator } = setup({ hostDockerSocket: '/nope/does/not/exist.sock' });
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `dsk-${id}.log`),
    });
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(makeSuccessContainer()),
    } as unknown as Docker;

    await makeOrchestrator(mockDocker).launch(run.id);

    const args = vi.mocked(mockDocker.createContainer).mock.calls[0][0];
    const binds = args.HostConfig!.Binds as string[];
    expect(binds.some((b) => b.endsWith(':/var/run/docker.sock'))).toBe(false);
  });
});
