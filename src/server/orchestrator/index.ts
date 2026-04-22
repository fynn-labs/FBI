import Docker from 'dockerode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import type { RunsRepo } from '../db/runs.js';
import type { ProjectsRepo } from '../db/projects.js';
import type { SecretsRepo } from '../db/secrets.js';
import type { SettingsRepo } from '../db/settings.js';
import type { McpServersRepo } from '../db/mcpServers.js';
import type { Config } from '../config.js';
import { buildContainerClaudeJson } from './claudeJson.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { LogStore } from '../logs/store.js';
import { ImageBuilder, ALWAYS, POSTBUILD } from './image.js';
import { ImageGc } from './imageGc.js';
import { parseResultJson } from './result.js';
import { SshAgentForwarding, type GitAuth } from './gitAuth.js';
import { classify, type RateLimitStateInput } from './resumeDetector.js';
import { ResumeScheduler } from './resumeScheduler.js';
import { scanSessionId, runMountDir } from './sessionId.js';
import type { RateLimitStateRepo } from '../db/rateLimitState.js';
import type { UsageRepo } from '../db/usage.js';
import { UsageTailer } from './usageTailer.js';
import { LimitMonitor } from './limitMonitor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(HERE, 'supervisor.sh');

export interface OrchestratorDeps {
  docker: Docker;
  config: Config;
  projects: ProjectsRepo;
  runs: RunsRepo;
  secrets: SecretsRepo;
  settings: SettingsRepo;
  mcpServers: McpServersRepo;
  streams: RunStreamRegistry;
  rateLimitState: RateLimitStateRepo;
  usage: UsageRepo;
}

export class Orchestrator {
  private imageBuilder: ImageBuilder;
  private gcTimer: NodeJS.Timeout | null = null;
  private gc: ImageGc;
  private scheduler: ResumeScheduler;

  constructor(private deps: OrchestratorDeps) {
    this.imageBuilder = new ImageBuilder(deps.docker);
    this.gc = new ImageGc(this.deps.docker, () => ({ always: ALWAYS, postbuild: POSTBUILD }));
    this.scheduler = new ResumeScheduler({
      runs: deps.runs,
      onFire: async (id) => {
        const run = this.deps.runs.get(id);
        if (!run || run.state !== 'awaiting_resume') return;
        await this.resume(id);
      },
    });
  }

  async startGcScheduler(): Promise<void> {
    const s = this.deps.settings.get();
    if (s.image_gc_enabled) await this.runGcOnce();
    this.scheduleNextGc();
  }

  private scheduleNextGc(): void {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.gcTimer = setTimeout(() => {
      void (async () => {
        const s = this.deps.settings.get();
        if (s.image_gc_enabled) await this.runGcOnce();
        this.scheduleNextGc();
      })();
    }, 24 * 60 * 60 * 1000);
  }

  async runGcOnce(): Promise<{ deletedCount: number; deletedBytes: number }> {
    const projects = this.deps.projects.list();
    const res = await this.gc.sweep(projects, Date.now());
    this.deps.settings.recordGc({
      at: Date.now(), count: res.deletedCount, bytes: res.deletedBytes,
    });
    return res;
  }

  private mountDirFor(runId: number): string {
    return runMountDir(this.deps.config.runsDir, runId);
  }

  private ensureMountDir(runId: number): string {
    const dir = this.mountDirFor(runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private publishState(runId: number): void {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    this.deps.streams.getOrCreateState(runId).publish({
      type: 'state',
      state: run.state,
      next_resume_at: run.next_resume_at,
      resume_attempts: run.resume_attempts,
      last_limit_reset_at: run.last_limit_reset_at,
    });
  }

  private async createContainerForRun(
    runId: number,
    opts: { resumeSessionId: string | null },
    onBytes: (chunk: Uint8Array) => void,
  ): Promise<{ container: Docker.Container; imageTag: string; projectSecrets: Record<string, string>; authCleanup: () => void }> {
    const run = this.deps.runs.get(runId)!;
    const project = this.deps.projects.get(run.project_id)!;
    const memMb = project.mem_mb ?? this.deps.config.containerMemMb;
    const cpus = project.cpus ?? this.deps.config.containerCpus;
    const pids = project.pids_limit ?? this.deps.config.containerPids;

    onBytes(Buffer.from(`[fbi] resolving image\n`));
    const devcontainerFiles = await fetchDevcontainerFile(
      project.repo_url, this.deps.config.hostSshAuthSock, onBytes,
    );
    const imageTag = await this.imageBuilder.resolve({
      projectId: project.id,
      devcontainerFiles,
      overrideJson: project.devcontainer_override_json,
      onLog: onBytes,
    });
    onBytes(Buffer.from(`[fbi] image: ${imageTag}\n`));

    const auth: GitAuth = new SshAgentForwarding(this.deps.config.hostSshAuthSock);
    const projectSecrets = this.deps.secrets.decryptAll(project.id);
    const authorName = project.git_author_name ?? this.deps.config.gitAuthorName;
    const authorEmail = project.git_author_email ?? this.deps.config.gitAuthorEmail;

    const settingsData = this.deps.settings.get();
    const marketplaces = uniq([...settingsData.global_marketplaces, ...project.marketplaces]);
    const plugins = uniq([...settingsData.global_plugins, ...project.plugins]);

    const mountDir = this.ensureMountDir(runId);

    onBytes(Buffer.from(`[fbi] starting container\n`));
    const container = await this.deps.docker.createContainer({
      Image: imageTag,
      name: `fbi-run-${runId}-${Date.now()}`,
      User: 'agent',
      Env: [
        `RUN_ID=${runId}`,
        `REPO_URL=${project.repo_url}`,
        `DEFAULT_BRANCH=${project.default_branch}`,
        `GIT_AUTHOR_NAME=${authorName}`,
        `GIT_AUTHOR_EMAIL=${authorEmail}`,
        `FBI_MARKETPLACES=${marketplaces.join('\n')}`,
        `FBI_PLUGINS=${plugins.join('\n')}`,
        'IS_SANDBOX=1',
        ...(opts.resumeSessionId ? [`FBI_RESUME_SESSION_ID=${opts.resumeSessionId}`] : []),
        ...Object.entries(auth.env()).map(([k, v]) => `${k}=${v}`),
        ...Object.entries(projectSecrets).map(([k, v]) => `${k}=${v}`),
      ],
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      Entrypoint: ['/usr/local/bin/supervisor.sh'],
      HostConfig: {
        AutoRemove: false,
        Memory: memMb * 1024 * 1024,
        NanoCpus: Math.round(cpus * 1e9),
        PidsLimit: pids,
        Binds: [
          `${SUPERVISOR}:/usr/local/bin/supervisor.sh:ro`,
          `${mountDir}:/home/agent/.claude/projects/`,
          ...claudeAuthMounts(this.deps.config.hostClaudeDir),
          ...auth.mounts().map((m) =>
            `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
          ),
        ],
      },
    });

    return { container, imageTag, projectSecrets, authCleanup: () => { /* no-op */ } };
  }

  /** Kicks off a queued run. Fire-and-forget; state transitions go through DB. */
  async launch(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.state !== 'queued') throw new Error(`run ${runId} not queued`);
    const project = this.deps.projects.get(run.project_id);
    if (!project) throw new Error(`project ${run.project_id} missing`);

    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
    };

    const branchHint = run.branch_name;
    const preamble = [
      `You are working in /workspace on ${project.repo_url}.`,
      `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
      branchHint
        ? `Create or check out a branch named \`${branchHint}\`,`
        : `Create or check out a branch appropriately named for this task,`,
      'do your work there, and leave all commits on that branch.',
      '',
    ].join('\n');

    let tailer: UsageTailer | null = null;
    let limitMonitor: LimitMonitor | null = null;

    try {
      const { container, projectSecrets } = await this.createContainerForRun(
        runId, { resumeSessionId: null }, onBytes,
      );
      const effectiveMcps = this.deps.mcpServers.listEffective(project.id);

      await injectFiles(container, '/fbi', {
        'prompt.txt': run.prompt ?? '',
        'instructions.txt': project.instructions ?? '',
        'global.txt': this.deps.settings.get().global_prompt,
        'preamble.txt': preamble,
      });
      const claudeJson = buildContainerClaudeJson(
        this.deps.config.hostClaudeDir, effectiveMcps, projectSecrets,
      );
      await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);
      await injectFiles(
        container, '/home/agent/.claude',
        { 'settings.json': JSON.stringify({ skipDangerousModePermissionPrompt: true }) },
        1000,
      );

      const attach = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });
      limitMonitor = this.makeLimitMonitor(runId, container, attach, onBytes);
      attach.on('data', (c: Buffer) => { limitMonitor!.feedLog(c); onBytes(c); });
      await container.start();
      limitMonitor.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markStarted(runId, container.id);
      this.publishState(runId);

      const events = this.deps.streams.getOrCreateEvents(runId);
      tailer = new UsageTailer({
        dir: this.mountDirFor(runId),
        pollMs: 500,
        onUsage: (snapshot) => {
          this.deps.usage.insertUsageEvent({ run_id: runId, ts: Date.now(), snapshot, rate_limit: null });
          events.publish({ type: 'usage', snapshot });
        },
        onRateLimit: (snapshot) => {
          this.deps.usage.upsertRateLimitState({ observed_at: Date.now(), observed_from_run_id: runId, snapshot });
          const state = this.deps.usage.getRateLimitState(Date.now());
          events.publish({ type: 'rate_limit', snapshot: state });
        },
        onError: () => { this.deps.usage.bumpParseErrors(runId); },
      });
      tailer.start();

      await this.awaitAndComplete(runId, container, onBytes, store, broadcaster);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] error: ${msg}\n`));
      this.deps.runs.markFinished(runId, { state: 'failed', error: msg });
      this.publishState(runId);
      this.active.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    } finally {
      if (tailer) await tailer.stop();
      if (limitMonitor) limitMonitor.stop();
    }
  }

  private async awaitAndComplete(
    runId: number,
    container: Docker.Container,
    onBytes: (chunk: Uint8Array) => void,
    store: LogStore,
    broadcaster: ReturnType<RunStreamRegistry['getOrCreate']>,
  ): Promise<void> {
    const waitRes = await container.wait();
    const inspect = await container.inspect().catch(() => null);
    const oomKilled = Boolean(inspect?.State?.OOMKilled);
    const wasCancelled = this.cancelled.delete(runId);
    const resultText = await readFileFromContainer(container, '/tmp/result.json').catch(() => '');
    const parsed = parseResultJson(resultText);

    // Capture Claude session id from the mount (idempotent on repeat runs).
    const sessionId = scanSessionId(this.mountDirFor(runId));
    if (sessionId) this.deps.runs.setClaudeSessionId(runId, sessionId);

    const failedNormally =
      !(waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0);
    const settings = this.deps.settings.get();

    if (failedNormally && !wasCancelled && settings.auto_resume_enabled) {
      const logTail = Buffer.from(LogStore.readAll(this.deps.runs.get(runId)!.log_path)).toString('utf8');
      const rls = this.deps.rateLimitState.get();
      const rlsInput: RateLimitStateInput | null = rls ? {
        requests_remaining: rls.requests_remaining,
        requests_limit: rls.requests_limit,
        tokens_remaining: rls.tokens_remaining,
        tokens_limit: rls.tokens_limit,
        reset_at: rls.reset_at,
      } : null;
      const verdict = classify(logTail, rlsInput, Date.now());

      if (verdict.kind === 'rate_limit' && verdict.reset_at !== null) {
        const run = this.deps.runs.get(runId)!;
        if (run.resume_attempts + 1 > settings.auto_resume_max_attempts) {
          onBytes(Buffer.from(
            `\n[fbi] rate limited; exceeded auto-resume cap (${settings.auto_resume_max_attempts} attempts)\n`,
          ));
          this.deps.runs.markFinished(runId, {
            state: 'failed',
            error: `rate limited; exceeded auto-resume cap (${settings.auto_resume_max_attempts} attempts)`,
          });
          this.publishState(runId);
        } else {
          this.deps.runs.markAwaitingResume(runId, {
            next_resume_at: verdict.reset_at,
            last_limit_reset_at: verdict.reset_at,
          });
          onBytes(Buffer.from(
            `\n[fbi] awaiting resume until ${new Date(verdict.reset_at).toISOString()}\n`,
          ));
          this.publishState(runId);
          this.scheduler.schedule(runId, verdict.reset_at);
          await container.remove({ force: true, v: true }).catch(() => {});
          this.active.delete(runId);
          // Close and re-open on resume — resume() opens in append mode.
          store.close(); broadcaster.end();
          return;
        }
        await container.remove({ force: true, v: true }).catch(() => {});
        this.active.delete(runId);
        store.close(); broadcaster.end();
        this.deps.streams.release(runId);
        return;
      }
      if (verdict.kind === 'rate_limit') {
        onBytes(Buffer.from(`\n[fbi] rate limited but no reset time available; failing\n`));
      }
    }

    // Normal terminal path.
    const state: 'succeeded' | 'failed' | 'cancelled' = wasCancelled
      ? 'cancelled'
      : waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0
        ? 'succeeded'
        : 'failed';
    const branchFromResult =
      parsed?.branch && parsed.branch.length > 0 ? parsed.branch : null;
    const memMb = this.deps.projects.get(this.deps.runs.get(runId)!.project_id)?.mem_mb ?? this.deps.config.containerMemMb;
    this.deps.runs.markFinished(runId, {
      state,
      exit_code: parsed?.exit_code ?? waitRes.StatusCode,
      head_commit: parsed?.head_sha ?? null,
      branch_name: branchFromResult,
      error: state === 'failed'
        ? oomKilled
          ? `container OOM (memory cap ${memMb} MB)`
          : parsed
            ? parsed.push_exit !== 0
              ? `git push failed (code ${parsed.push_exit})`
              : `agent exit ${parsed.exit_code}`
            : `container exit ${waitRes.StatusCode}`
        : null,
    });
    onBytes(Buffer.from(`\n[fbi] run ${state}\n`));
    this.publishState(runId);
    await container.remove({ force: true, v: true }).catch(() => {});
    this.active.delete(runId);
    store.close(); broadcaster.end();
    this.deps.streams.release(runId);
  }

  async resume(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.state !== 'awaiting_resume') return;

    // Reuse the existing log store and broadcaster.
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => { store.append(chunk); broadcaster.publish(chunk); };

    onBytes(Buffer.from(
      `\n[fbi] resuming (attempt ${run.resume_attempts} of ${this.deps.settings.get().auto_resume_max_attempts})\n`,
    ));

    try {
      const sessionId = run.claude_session_id; // may be null — supervisor falls through to fresh
      const { container } = await this.createContainerForRun(
        runId, { resumeSessionId: sessionId }, onBytes,
      );

      if (!sessionId) {
        onBytes(Buffer.from(`[fbi] resume: no session captured, starting fresh\n`));
        const project = this.deps.projects.get(run.project_id)!;
        const preamble = [
          `You are working in /workspace on ${project.repo_url}.`,
          `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
          run.branch_name
            ? `Create or check out a branch named \`${run.branch_name}\`,`
            : `Create or check out a branch appropriately named for this task,`,
          'do your work there, and leave all commits on that branch.',
          '',
        ].join('\n');
        await injectFiles(container, '/fbi', {
          'prompt.txt': run.prompt ?? '',
          'instructions.txt': project.instructions ?? '',
          'global.txt': this.deps.settings.get().global_prompt,
          'preamble.txt': preamble,
        });
      }

      const projectSecrets = this.deps.secrets.decryptAll(run.project_id);
      const effectiveMcps = this.deps.mcpServers.listEffective(run.project_id);
      const claudeJson = buildContainerClaudeJson(
        this.deps.config.hostClaudeDir, effectiveMcps, projectSecrets,
      );
      await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);
      await injectFiles(
        container, '/home/agent/.claude',
        { 'settings.json': JSON.stringify({ skipDangerousModePermissionPrompt: true }) },
        1000,
      );

      const attach = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });
      const limitMonitor = this.makeLimitMonitor(runId, container, attach, onBytes);
      attach.on('data', (c: Buffer) => { limitMonitor.feedLog(c); onBytes(c); });
      await container.start();
      limitMonitor.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markResuming(runId, container.id);
      this.publishState(runId);

      try {
        await this.awaitAndComplete(runId, container, onBytes, store, broadcaster);
      } finally {
        limitMonitor.stop();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] resume error: ${msg}\n`));
      this.deps.runs.markFinished(runId, { state: 'failed', error: `resume failed: ${msg}` });
      this.publishState(runId);
      this.active.delete(runId);
      store.close(); broadcaster.end(); this.deps.streams.release(runId);
    }
  }

  /**
   * Builds a LimitMonitor that nudges Claude to exit when its in-TUI
   * rate-limit message appears. Newer Claude Code wordings ("You've hit your
   * limit · resets <time>") display the limit in-TUI without exiting, so the
   * container waits forever and the existing classify()-at-exit flow never
   * runs. We send Ctrl-C so Claude exits cleanly and supervisor.sh can still
   * commit+push the WIP; SIGKILL is the 30s fallback.
   */
  private makeLimitMonitor(
    runId: number,
    container: Docker.Container,
    attach: NodeJS.ReadWriteStream,
    onBytes: (chunk: Uint8Array) => void,
  ): LimitMonitor {
    return new LimitMonitor({
      mountDir: this.mountDirFor(runId),
      onDetect: () => {
        if (!this.deps.settings.get().auto_resume_enabled) return;
        onBytes(Buffer.from(
          '\n[fbi] rate-limit message detected in stream; sending SIGINT to claude\n',
        ));
        try { attach.write(Buffer.from([0x03])); } catch { /* already closed */ }
        setTimeout(() => {
          container.kill().catch(() => { /* already stopped */ });
        }, 30_000).unref?.();
      },
    });
  }

  // Active run bookkeeping.
  private active = new Map<
    number,
    { container: Docker.Container; attachStream: NodeJS.ReadWriteStream }
  >();

  /** Forward stdin bytes from the UI to the container. */
  writeStdin(runId: number, bytes: Uint8Array): void {
    const a = this.active.get(runId);
    if (!a) return;
    a.attachStream.write(Buffer.from(bytes));
  }

  /** Resize the container's TTY. */
  async resize(runId: number, cols: number, rows: number): Promise<void> {
    const a = this.active.get(runId);
    if (!a) return;
    await a.container.resize({ w: cols, h: rows }).catch(() => {});
  }

  /** Cancel a running run. Safe to call on non-running runs (no-op). */
  async cancel(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    if (run.state === 'awaiting_resume') {
      this.scheduler.cancel(runId);
      this.deps.runs.markFinished(runId, { state: 'cancelled', error: null });
      this.publishState(runId);
      const bc = this.deps.streams.get(runId);
      bc?.end();
      this.deps.streams.release(runId);
      return;
    }
    const a = this.active.get(runId);
    if (!a) return;
    await a.container.stop({ t: 10 }).catch(() => {});
    // the launch() loop observes wait() resolving and handles teardown;
    // mark intent here so it classifies state correctly.
    this.cancelled.add(runId);
  }

  private cancelled = new Set<number>();

  /** Returns the container handle for a run that is currently running or
   *  resuming, or null if the run has no live container. */
  getLiveContainer(runId: number): Docker.Container | null {
    return this.active.get(runId)?.container ?? null;
  }

  fireResumeNow(runId: number): void {
    this.scheduler.fireNow(runId);
  }

  async rehydrateSchedules(): Promise<void> {
    await this.scheduler.rehydrate();
  }

  /**
   * Called at startup. For each run in state='running', try to reattach; if
   * the container is gone, mark the run failed.
   */
  async recover(): Promise<void> {
    const running = this.deps.runs.listByState('running');
    for (const run of running) {
      if (!run.container_id) {
        this.deps.runs.markFinished(run.id, {
          state: 'failed',
          error: 'orchestrator lost container (no container_id recorded)',
        });
        continue;
      }
      try {
        const container = this.deps.docker.getContainer(run.container_id);
        await container.inspect();
        this.reattach(run.id, container).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.deps.runs.markFinished(run.id, {
            state: 'failed',
            error: `reattach failed: ${msg}`,
          });
        });
      } catch {
        this.deps.runs.markFinished(run.id, {
          state: 'failed',
          error: 'orchestrator lost container (container gone on restart)',
        });
      }
    }
  }

  private async reattach(runId: number, container: Docker.Container): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    const project = this.deps.projects.get(run.project_id);
    const memMb =
      project?.mem_mb ?? this.deps.config.containerMemMb;
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
    };

    onBytes(Buffer.from(`\n[fbi] reattached after orchestrator restart\n`));

    // Stdin: fresh attach with only stdin.
    const attachStream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    });
    this.active.set(runId, { container, attachStream });

    const claudeProjectsDir = path.join(this.deps.config.runsDir, String(runId), 'claude-projects');
    fs.mkdirSync(claudeProjectsDir, { recursive: true, mode: 0o777 });

    // Output: follow container.logs from where we left off, and feed into the
    // same LimitMonitor used by fresh launches so a pre-existing container
    // stuck on the in-TUI rate-limit message also gets nudged out.
    const limitMonitor = this.makeLimitMonitor(runId, container, attachStream, onBytes);
    const sinceSec = Math.floor((run.started_at ?? Date.now()) / 1000);
    const logsStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      since: sinceSec,
    })) as unknown as NodeJS.ReadableStream;
    logsStream.on('data', (c: Buffer) => { limitMonitor.feedLog(c); onBytes(c); });
    limitMonitor.start();
    const events = this.deps.streams.getOrCreateEvents(runId);
    const tailer = new UsageTailer({
      dir: claudeProjectsDir,
      pollMs: 500,
      onUsage: (snapshot) => {
        this.deps.usage.insertUsageEvent({
          run_id: runId, ts: Date.now(), snapshot, rate_limit: null,
        });
        events.publish({ type: 'usage', snapshot });
      },
      onRateLimit: (snapshot) => {
        this.deps.usage.upsertRateLimitState({
          observed_at: Date.now(),
          observed_from_run_id: runId,
          snapshot,
        });
        const state = this.deps.usage.getRateLimitState(Date.now());
        events.publish({ type: 'rate_limit', snapshot: state });
      },
      onError: () => { this.deps.usage.bumpParseErrors(runId); },
    });
    tailer.start();

    try {
      const waitRes = await container.wait();
      const inspect = await container.inspect().catch(() => null);
      const oomKilled = Boolean(inspect?.State?.OOMKilled);
      const wasCancelled = this.cancelled.delete(runId);
      const resultText = await readFileFromContainer(
        container,
        '/tmp/result.json'
      ).catch(() => '');
      const parsed = parseResultJson(resultText);

      const state: 'succeeded' | 'failed' | 'cancelled' = wasCancelled
        ? 'cancelled'
        : waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0
          ? 'succeeded'
          : 'failed';

      const branchFromResult =
        parsed?.branch && parsed.branch.length > 0 ? parsed.branch : null;

      this.deps.runs.markFinished(runId, {
        state,
        exit_code: parsed?.exit_code ?? waitRes.StatusCode,
        head_commit: parsed?.head_sha ?? null,
        branch_name: branchFromResult,
        error:
          state === 'failed'
            ? oomKilled
              ? `container OOM (memory cap ${memMb} MB)`
              : parsed
                ? parsed.push_exit !== 0
                  ? `git push failed (code ${parsed.push_exit})`
                  : `agent exit ${parsed.exit_code}`
                : `container exit ${waitRes.StatusCode}`
            : null,
      });

      await container.remove({ force: true, v: true }).catch(() => {});
    } finally {
      await tailer.stop();
      limitMonitor.stop();
      events.end();
      this.active.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
  }
}

// Bind-mount OAuth tokens. On Linux they live in ~/.claude/.credentials.json;
// macOS uses Keychain so nothing to mount. ~/.claude.json is injected separately
// (see buildContainerClaudeJson) so we can strip host-specific fields.
function claudeAuthMounts(hostClaudeDir: string): string[] {
  const hostCreds = path.join(hostClaudeDir, '.credentials.json');
  return fs.existsSync(hostCreds)
    ? [`${hostCreds}:/home/agent/.claude/.credentials.json`]
    : [];
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

async function injectFiles(
  container: Docker.Container,
  destDir: string,
  files: Record<string, string>,
  uid?: number
): Promise<void> {
  const tar = await import('tar-stream');
  const pack = tar.pack();
  for (const [name, contents] of Object.entries(files)) {
    const header: { name: string; mode: number; uid?: number; gid?: number } = {
      name, mode: 0o644,
    };
    if (uid !== undefined) { header.uid = uid; header.gid = uid; }
    pack.entry(header, contents);
  }
  pack.finalize();
  await container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: destDir });
}

// Sparse-shallow-clone the repo on the host to check for a repo-level
// devcontainer.json before building the image. Returns the file contents, or
// null if the file doesn't exist or the clone fails.
async function fetchDevcontainerFile(
  repoUrl: string,
  sshAuthSock: string,
  onLog: (chunk: Uint8Array) => void,
): Promise<Record<string, string> | null> {
  if (!sshAuthSock) return null;
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-dc-'));
  const tmp = path.join(tmpParent, 'r');
  try {
    const env = { ...process.env, SSH_AUTH_SOCK: sshAuthSock, GIT_TERMINAL_PROMPT: '0' };
    await execFileAsync(
      'git',
      ['clone', '--depth=1', '--filter=blob:none', '--sparse', '--no-tags', repoUrl, tmp],
      { env }
    );
    await execFileAsync('git', ['-C', tmp, 'sparse-checkout', 'set', '.devcontainer'], { env });
    await execFileAsync('git', ['-C', tmp, 'checkout'], { env });
    const dcDir = path.join(tmp, '.devcontainer');
    if (!fs.existsSync(path.join(dcDir, 'devcontainer.json'))) return null;
    const files: Record<string, string> = {};
    for (const entry of fs.readdirSync(dcDir)) {
      const full = path.join(dcDir, entry);
      if (fs.statSync(full).isFile()) {
        files[entry] = fs.readFileSync(full, 'utf8');
      }
    }
    onLog(Buffer.from(`[fbi] using repo .devcontainer/devcontainer.json\n`));
    return files;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
}

async function readFileFromContainer(
  container: Docker.Container,
  pathInContainer: string
): Promise<string> {
  const stream = await container.getArchive({ path: pathInContainer });
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const tarball = Buffer.concat(chunks);
  // The archive is a tar with a single file; extract it.
  const tar = await import('tar-stream');
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let content = '';
    extract.on('entry', (_, s, next) => {
      s.on('data', (d: Buffer) => (content += d.toString('utf8')));
      s.on('end', next);
      s.resume();
    });
    extract.on('finish', () => resolve(content));
    extract.on('error', reject);
    extract.end(tarball);
  });
}
