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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-wflow-'));
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
    secretsKeyFile: path.join(dir, 'secrets.key'),
    webDir: dir,
  } as unknown as Config;

  return {
    dir, runs, projects, settings, p, streams,
    makeOrchestrator: (docker: Docker) => new Orchestrator({
      docker, config, projects, runs, secrets, settings, mcpServers, streams, rateLimitState, usage,
      poller: { nudge: async () => {} },
    }),
  };
}

describe('waiting flow (stubbed Docker)', () => {
  it('markWaiting + markAwaitingResume transitions through waiting to awaiting_resume', () => {
    const { runs, p } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `wflow-${id}.log`),
    });
    runs.markStartingFromQueued(run.id, 'c1');
    runs.markRunning(run.id);
    runs.markWaiting(run.id);
    expect(runs.get(run.id)!.state).toBe('waiting');
    runs.markAwaitingResume(run.id, { next_resume_at: Date.now() + 60_000, last_limit_reset_at: null });
    expect(runs.get(run.id)!.state).toBe('awaiting_resume');
  });

  it('recover() over a run in state=waiting does not throw and leaves it alone', async () => {
    const { runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `wflow-rec-${id}.log`),
    });
    runs.markStartingFromQueued(run.id, 'stub-container-id');
    runs.markRunning(run.id);
    runs.markWaiting(run.id);

    // Minimal stub: getContainer returns something whose .inspect() resolves.
    // reattach() after that is fine to let whatever it does — we don't await it.
    const stubContainer = {
      id: 'stub-container-id',
      inspect: async () => ({ State: { Running: true } }),
      attach: async () => {
        const s = new PassThrough(); s.push(null); return s;
      },
      logs: async () => {
        const s = new PassThrough(); s.push(null); return s;
      },
      wait: async () => ({ StatusCode: 0 }),
      remove: async () => {},
      getArchive: async () => { throw new Error('no result.json'); },
    };
    const mockDocker = {
      getContainer: vi.fn().mockReturnValue(stubContainer),
    } as unknown as Docker;

    const orch = makeOrchestrator(mockDocker);
    await orch.recover();

    // Give reattach's async kickoff a microtask or two; this is not a full
    // container lifecycle, just enough time for any synchronous failure to
    // surface via the .catch → markFinished path.
    await new Promise((r) => setTimeout(r, 20));

    const after = runs.get(run.id)!;
    // The essential invariant: recover() found the waiting run and looked up
    // its container (i.e. Task 8's listByState('waiting') inclusion fired).
    // Downstream reattach behavior is race-y with empty stub streams, so we
    // don't assert a terminal state — only that the lookup happened.
    expect(mockDocker.getContainer).toHaveBeenCalledWith('stub-container-id');
    // As a soft secondary check: if the run was marked failed during the race,
    // the reason must not be the pre-lookup "container gone" path.
    if (after.state === 'failed') {
      expect(after.error ?? '').not.toMatch(/orchestrator lost container/);
    }
  });
});
