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
import { parseResultJson, classifyResultJson } from './result.js';
import { SshAgentForwarding, type GitAuth } from './gitAuth.js';
import { classify, type RateLimitStateInput } from './resumeDetector.js';
import type { RateLimitSnapshot } from '../../shared/types.js';
import { ResumeScheduler } from './resumeScheduler.js';
import { scanSessionId, runMountDir, runStateDir, runUploadsDir, runScriptsDir } from './sessionId.js';
import { snapshotScripts } from './snapshotScripts.js';
import { modelParamEnvEntries } from './modelParamEnv.js';
import { TitleWatcher } from './titleWatcher.js';
import type { RateLimitStateRepo } from '../db/rateLimitState.js';
import type { UsageRepo } from '../db/usage.js';
import { UsageTailer } from './usageTailer.js';
import { LimitMonitor } from './limitMonitor.js';
import { RuntimeStateWatcher, type DerivedRuntimeState } from './runtimeStateWatcher.js';
import { SafeguardWatcher } from './safeguardWatcher.js';
import { MirrorStatusPoller } from './mirrorStatusPoller.js';
import { dockerExec, type DockerExecOptions, type DockerExecResult } from './dockerExec.js';
import { buildEnv, runHistoryOpInContainer, runHistoryOpInTransientContainer, type ParsedOpResult } from './historyOp.js';
import type { HistoryOp } from '../../shared/types.js';
import { nudgeClaudeToExit } from './nudgeClaude.js';
import { checkContinueEligibility } from './continueEligibility.js';
import { makeOnBytes } from '../logs/onBytes.js';
import type { FilesPayload } from '../../shared/types.js';
import { WipRepo } from './wipRepo.js';
import { buildSafeguardBind } from './safeguardBind.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(HERE, 'supervisor.sh');
const FINALIZE_BRANCH = path.join(HERE, 'finalizeBranch.sh');
const HISTORY_OP = path.join(HERE, 'fbi-history-op.sh');

export class ContinueNotEligibleError extends Error {
  constructor(public readonly code: 'wrong_state' | 'no_session' | 'session_files_missing', message: string) {
    super(`${code}: ${message}`);
    this.name = 'ContinueNotEligibleError';
  }
}

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
  poller: { nudge: () => Promise<void> };
}

export class Orchestrator {
  private imageBuilder: ImageBuilder;
  private gcTimer: NodeJS.Timeout | null = null;
  private gc: ImageGc;
  private scheduler: ResumeScheduler;
  readonly wipRepo: WipRepo;

  constructor(private deps: OrchestratorDeps) {
    this.wipRepo = new WipRepo(this.deps.config.runsDir);
    // WipRepo.path(runId) produces `<runsDir>/<id>/wip.git` — same convention
    // as the existing per-run directories.
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

  private stateDirFor(runId: number): string {
    return runStateDir(this.deps.config.runsDir, runId);
  }

  private ensureStateDir(runId: number): string {
    const dir = this.stateDirFor(runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
    return dir;
  }

  private uploadsDirFor(runId: number): string {
    return runUploadsDir(this.deps.config.runsDir, runId);
  }

  private ensureUploadsDir(runId: number): string {
    const dir = this.uploadsDirFor(runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private ensureScriptsDir(runId: number): string {
    const dir = runScriptsDir(this.deps.config.runsDir, runId);
    snapshotScripts(dir, SUPERVISOR, FINALIZE_BRANCH, HISTORY_OP);
    return dir;
  }

  private publishState(runId: number): void {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    const frame = {
      type: 'state' as const,
      state: run.state,
      state_entered_at: run.state_entered_at,
      next_resume_at: run.next_resume_at,
      resume_attempts: run.resume_attempts,
      last_limit_reset_at: run.last_limit_reset_at,
    };
    this.deps.streams.getOrCreateState(runId).publish(frame);
    this.deps.streams.getGlobalStates().publish({
      ...frame,
      run_id: runId,
      project_id: run.project_id,
    });
  }

  /**
   * Public wrapper for the API endpoint: synchronously flips a terminated
   * run to `starting` and broadcasts the state change. The async
   * continueRun lifecycle (container creation, etc.) is kicked off
   * separately by the endpoint as fire-and-forget.
   */
  markStartingForContinueRequest(runId: number): void {
    this.deps.runs.markStartingForContinueRequest(runId);
    this.publishState(runId);
  }

  private publishTitleUpdate(runId: number, title: string): void {
    this.deps.runs.updateTitle(runId, title, { respectLock: true });
    const after = this.deps.runs.get(runId);
    this.deps.streams.getOrCreateEvents(runId).publish({
      type: 'title',
      title: after?.title ?? null,
      title_locked: (after?.title_locked ?? 0) as 0 | 1,
    });
  }

  private async createContainerForRun(
    runId: number,
    opts: { resumeSessionId: string | null; branchName: string | null },
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

    const auth: GitAuth = new SshAgentForwarding(
      this.deps.config.hostSshAuthSock,
      this.deps.config.hostBindSshAuthSock ?? this.deps.config.hostSshAuthSock,
    );
    const projectSecrets = this.deps.secrets.decryptAll(project.id);
    const authorName = project.git_author_name ?? this.deps.config.gitAuthorName;
    const authorEmail = project.git_author_email ?? this.deps.config.gitAuthorEmail;

    const settingsData = this.deps.settings.get();
    const marketplaces = uniq([...settingsData.global_marketplaces, ...project.marketplaces]);
    const plugins = uniq([...settingsData.global_plugins, ...project.plugins]);

    const mountDir = this.ensureMountDir(runId);
    const scriptsDir = this.ensureScriptsDir(runId);
    const toBindHost = (localPath: string): string => {
      const { runsDir, hostRunsDir } = this.deps.config;
      if (!hostRunsDir || hostRunsDir === runsDir) return localPath;
      if (localPath.startsWith(runsDir)) {
        return hostRunsDir + localPath.slice(runsDir.length);
      }
      return localPath;
    };

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
        // FBI_BRANCH = where the agent checks out, commits, and pushes.
        // The user's typed branch wins; if none, supervisor.sh falls back to
        // claude/run-N (used only as a fallback branch name when FBI_BRANCH is
        // not provided).
        ...(run.branch_name ? [`FBI_BRANCH=${run.branch_name}`] : []),
        ...(opts.resumeSessionId ? [`FBI_RESUME_SESSION_ID=${opts.resumeSessionId}`] : []),
        ...Object.entries(auth.env()).map(([k, v]) => `${k}=${v}`),
        ...Object.entries(projectSecrets).map(([k, v]) => `${k}=${v}`),
        ...modelParamEnvEntries(run),
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
          `${toBindHost(path.join(scriptsDir, 'supervisor.sh'))}:/usr/local/bin/supervisor.sh:ro`,
          `${toBindHost(path.join(scriptsDir, 'finalizeBranch.sh'))}:/usr/local/bin/fbi-finalize-branch.sh:ro`,
          `${toBindHost(path.join(scriptsDir, 'fbi-history-op.sh'))}:/usr/local/bin/fbi-history-op.sh:ro`,
          buildSafeguardBind(
            this.deps.config.runsDir,
            runId,
            this.deps.config.hostRunsDir,
          ),
          `${toBindHost(mountDir)}:/home/agent/.claude/projects/`,
          `${toBindHost(this.ensureStateDir(runId))}:/fbi-state/`,
          `${toBindHost(this.ensureUploadsDir(runId))}:/fbi/uploads:ro`,
          ...claudeAuthMounts(
            this.deps.config.hostClaudeDir,
            this.deps.config.hostBindClaudeDir ?? this.deps.config.hostClaudeDir,
          ),
          ...dockerSocketMounts(this.deps.config.hostDockerSocket),
          ...auth.mounts().map((m) =>
            `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
          ),
        ],
        ...(this.deps.config.hostDockerGid !== null
          ? { GroupAdd: [String(this.deps.config.hostDockerGid)] }
          : {}),
      },
    });

    return { container, imageTag, projectSecrets, authCleanup: () => { /* no-op */ } };
  }

  /**
   * Preamble lines about the run branch for inclusion in prompts.
   * Used by both launch() and resume().
   */
  private branchPreambleLines(runId: number, branchName: string | null): string[] {
    const branch = branchName && branchName.length > 0 ? branchName : `claude/run-${runId}`;
    return [
      `You are working on branch \`${branch}\`. Make all commits here.`,
      `Do NOT push to or modify any other branch.`,
    ];
  }

  /**
   * Start the SafeguardWatcher and MirrorStatusPoller for an active run.
   * Returns handles for both so callers can stop them in a finally block.
   */
  private async startRunObservers(
    runId: number,
    branchName: string | null,
    events: ReturnType<RunStreamRegistry['getOrCreateEvents']>,
  ): Promise<{ safeguardWatcher: SafeguardWatcher; mirrorPoller: MirrorStatusPoller }> {
    const safeguardWatcher = new SafeguardWatcher({
      bareDir: this.wipRepo.path(runId),
      branch: branchName ?? `claude/run-${runId}`,
      onSnapshot: (snap) => {
        this.lastFiles.set(runId, snap);
        const runNow = this.deps.runs.get(runId);
        events.publish({
          type: 'changes',
          branch_name: runNow?.branch_name || null,
          branch_base: snap.branchBase,
          commits: [],
          uncommitted: snap.dirty,
          integrations: {},
          dirty_submodules: [],
          children: [],
        });
      },
    });
    await safeguardWatcher.start();
    const mirrorPoller = new MirrorStatusPoller({
      path: `${this.stateDirFor(runId)}/mirror-status`,
      pollMs: 1000,
      onChange: (s) => { this.deps.runs.setMirrorStatus(runId, s); },
    });
    mirrorPoller.start();
    return { safeguardWatcher, mirrorPoller };
  }

  private async stopRunObservers(obs: {
    safeguardWatcher: SafeguardWatcher;
    mirrorPoller: MirrorStatusPoller;
  }): Promise<void> {
    await obs.safeguardWatcher.stop();
    obs.mirrorPoller.stop();
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
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = makeOnBytes(store, broadcaster, screen);

    const preamble = [
      `You are working in /workspace on ${project.repo_url}.`,
      `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
      ...this.branchPreambleLines(run.id, run.branch_name),
      '',
      'As soon as you understand the task, write a short name (4–8 words,',
      'imperative, no trailing punctuation) describing this session to',
      '`/fbi-state/session-name`. You may overwrite it later if your',
      'understanding changes. Also include a refined `title` field in the',
      'final result JSON.',
      '',
    ].join('\n');

    let tailer: UsageTailer | null = null;
    let titleWatcher: TitleWatcher | null = null;
    let limitMonitor: LimitMonitor | null = null;
    let runtimeWatcher: RuntimeStateWatcher | null = null;
    let observers: { safeguardWatcher: SafeguardWatcher; mirrorPoller: MirrorStatusPoller } | null = null;

    try {
      const { container, projectSecrets } = await this.createContainerForRun(
        runId, { resumeSessionId: null, branchName: null }, onBytes,
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
        { 'settings.json': buildClaudeSettingsJson() },
        1000,
      );

      const attach = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });
      limitMonitor = this.makeLimitMonitor(runId, container, attach, onBytes);
      runtimeWatcher = this.makeRuntimeStateWatcher(runId);
      attach.on('data', (c: Buffer) => {
        limitMonitor!.feedLog(c);
        onBytes(c);
      });
      await container.start();
      limitMonitor.start();
      runtimeWatcher.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markStartingFromQueued(runId, container.id);
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
          this.lastRateLimit.set(runId, snapshot);
          if (snapshot.reset_at != null) {
            this.deps.runs.updateLastLimitResetAt(runId, snapshot.reset_at);
          }
          // No global rate_limit_state write; poller owns that.
        },
        onError: () => { this.deps.usage.bumpParseErrors(runId); },
      });
      tailer.start();
      titleWatcher = new TitleWatcher({
        path: `${this.stateDirFor(runId)}/session-name`,
        pollMs: 1000,
        onTitle: (t) => this.publishTitleUpdate(runId, t),
        onError: () => { /* swallow — best effort */ },
      });
      titleWatcher.start();
      observers = await this.startRunObservers(runId, run.branch_name ?? null, events);
      void this.deps.poller.nudge();

      await this.awaitAndComplete(runId, container, onBytes, store, broadcaster);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] error: ${msg}\n`));
      this.deps.runs.markFinished(runId, { state: 'failed', error: msg });
      this.publishState(runId);
      this.active.delete(runId); this.lastFiles.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    } finally {
      if (tailer) await tailer.stop();
      if (titleWatcher) await titleWatcher.stop();
      if (limitMonitor) limitMonitor.stop();
      if (runtimeWatcher) runtimeWatcher.stop();
      if (observers) await this.stopRunObservers(observers);
    }
  }

  private async awaitAndComplete(
    runId: number,
    container: Docker.Container,
    onBytes: (chunk: Uint8Array) => void,
    store: LogStore,
    broadcaster: ReturnType<RunStreamRegistry['getOrCreate']>,
  ): Promise<void> {
    try {
      const waitRes = await container.wait();
      const inspect = await container.inspect().catch(() => null);
      const oomKilled = Boolean(inspect?.State?.OOMKilled);
      const wasCancelled = this.cancelled.delete(runId);
      const resultText = await readFileFromContainer(container, '/tmp/result.json').catch(() => '');
      const classification = classifyResultJson(resultText);
      const parsed = parseResultJson(resultText);

      // Capture Claude session id from the mount (idempotent on repeat runs).
      const sessionId = scanSessionId(this.mountDirFor(runId));
      if (sessionId) this.deps.runs.setClaudeSessionId(runId, sessionId);

      // Resume-restore failure: set resume_failed state and bail out early.
      if (classification.kind === 'resume_failed') {
        const errMsg = `restore failed (${classification.error})`;
        onBytes(Buffer.from(`\n[fbi] ${errMsg}\n`));
        this.deps.runs.markResumeFailed(runId, errMsg);
        this.publishState(runId);
        await container.remove({ force: true, v: true }).catch(() => {});
        this.active.delete(runId); this.lastFiles.delete(runId);
        store.close(); broadcaster.end();
        this.deps.streams.release(runId);
        return;
      }

      const failedNormally =
        !(waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0);
      const settings = this.deps.settings.get();

      if (failedNormally && !wasCancelled && settings.auto_resume_enabled) {
        const logTail = Buffer.from(LogStore.readAll(this.deps.runs.get(runId)!.log_path)).toString('utf8');
        const snap = this.lastRateLimit.get(runId) ?? null;
        const rlsInput: RateLimitStateInput | null = snap ? {
          requests_remaining: snap.requests_remaining,
          requests_limit: snap.requests_limit,
          tokens_remaining: snap.tokens_remaining,
          tokens_limit: snap.tokens_limit,
          reset_at: snap.reset_at,
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
            if (parsed?.title) {
              this.publishTitleUpdate(runId, parsed.title);
            }
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
            this.active.delete(runId); this.lastFiles.delete(runId);
            // Close and re-open on resume — resume() opens in append mode.
            store.close(); broadcaster.end();
            return;
          }
          await container.remove({ force: true, v: true }).catch(() => {});
          this.active.delete(runId); this.lastFiles.delete(runId);
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
      if (parsed?.title) {
        this.publishTitleUpdate(runId, parsed.title);
      }
      onBytes(Buffer.from(`\n[fbi] run ${state}\n`));
      this.publishState(runId);
      await container.remove({ force: true, v: true }).catch(() => {});
      this.active.delete(runId); this.lastFiles.delete(runId);
      store.close(); broadcaster.end();
      this.deps.streams.release(runId);
    } finally {
      this.lastRateLimit.delete(runId);
      void this.deps.poller.nudge();
    }
  }

  async resume(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.state !== 'awaiting_resume') return;

    // Reuse the existing log store and broadcaster.
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = makeOnBytes(store, broadcaster, screen);

    onBytes(Buffer.from(
      `\n[fbi] resuming (attempt ${run.resume_attempts} of ${this.deps.settings.get().auto_resume_max_attempts})\n`,
    ));

    try {
      const sessionId = run.claude_session_id; // may be null — supervisor falls through to fresh
      const { container } = await this.createContainerForRun(
        runId, {
          resumeSessionId: sessionId,
          branchName: run.branch_name && run.branch_name.length > 0 ? run.branch_name : null,
        }, onBytes,
      );

      if (!sessionId) {
        onBytes(Buffer.from(`[fbi] resume: no session captured, starting fresh\n`));
        const project = this.deps.projects.get(run.project_id)!;
        const preamble = [
          `You are working in /workspace on ${project.repo_url}.`,
          `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
          ...this.branchPreambleLines(run.id, run.branch_name),
          '',
          'As soon as you understand the task, write a short name (4–8 words,',
          'imperative, no trailing punctuation) describing this session to',
          '`/fbi-state/session-name`. You may overwrite it later if your',
          'understanding changes. Also include a refined `title` field in the',
          'final result JSON.',
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
        { 'settings.json': buildClaudeSettingsJson() },
        1000,
      );

      const attach = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });
      const limitMonitor = this.makeLimitMonitor(runId, container, attach, onBytes);
      const runtimeWatcher = this.makeRuntimeStateWatcher(runId);
      attach.on('data', (c: Buffer) => { limitMonitor.feedLog(c); onBytes(c); });
      await container.start();
      limitMonitor.start();
      this.clearRuntimeSentinels(runId);
      runtimeWatcher.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markStartingForResume(runId, container.id);
      this.publishState(runId);

      const events = this.deps.streams.getOrCreateEvents(runId);
      const titleWatcher = new TitleWatcher({
        path: `${this.stateDirFor(runId)}/session-name`,
        pollMs: 1000,
        onTitle: (t) => this.publishTitleUpdate(runId, t),
        onError: () => { /* swallow — best effort */ },
      });
      titleWatcher.start();
      const observers = await this.startRunObservers(runId, run.branch_name ?? null, events);

      try {
        await this.awaitAndComplete(runId, container, onBytes, store, broadcaster);
      } finally {
        await titleWatcher.stop();
        await this.stopRunObservers(observers);
        limitMonitor.stop();
        runtimeWatcher.stop();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] resume error: ${msg}\n`));
      this.deps.runs.markFinished(runId, { state: 'failed', error: `resume failed: ${msg}` });
      this.publishState(runId);
      this.active.delete(runId); this.lastFiles.delete(runId);
      store.close(); broadcaster.end(); this.deps.streams.release(runId);
    }
  }

  async continueRun(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    // API endpoint has already validated eligibility and flipped to 'starting'.
    // Bail defensively if state is no longer 'starting' (e.g., a cancel raced us).
    if (run.state !== 'starting') {
      throw new ContinueNotEligibleError(
        'wrong_state',
        `continueRun: expected state 'starting' (set by API), got '${run.state}'`,
      );
    }

    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = makeOnBytes(store, broadcaster, screen);
    onBytes(Buffer.from(`\n[fbi] continuing from session ${run.claude_session_id}\n`));

    try {
      const { container } = await this.createContainerForRun(
        runId, {
          resumeSessionId: run.claude_session_id,
          branchName: run.branch_name && run.branch_name.length > 0 ? run.branch_name : null,
        }, onBytes,
      );

      const projectSecrets = this.deps.secrets.decryptAll(run.project_id);
      const effectiveMcps = this.deps.mcpServers.listEffective(run.project_id);
      const claudeJson = buildContainerClaudeJson(
        this.deps.config.hostClaudeDir, effectiveMcps, projectSecrets,
      );
      await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);
      await injectFiles(
        container, '/home/agent/.claude',
        { 'settings.json': buildClaudeSettingsJson() },
        1000,
      );

      const attach = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });
      const limitMonitor = this.makeLimitMonitor(runId, container, attach, onBytes);
      const runtimeWatcher = this.makeRuntimeStateWatcher(runId);
      attach.on('data', (c: Buffer) => { limitMonitor.feedLog(c); onBytes(c); });
      await container.start();
      limitMonitor.start();
      this.clearRuntimeSentinels(runId);
      runtimeWatcher.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markStartingContainer(runId, container.id);
      this.publishState(runId);

      const events = this.deps.streams.getOrCreateEvents(runId);
      const titleWatcher = new TitleWatcher({
        path: `${this.stateDirFor(runId)}/session-name`,
        pollMs: 1000,
        onTitle: (t) => this.publishTitleUpdate(runId, t),
        onError: () => { /* swallow — best effort */ },
      });
      titleWatcher.start();
      const observers = await this.startRunObservers(runId, run.branch_name ?? null, events);

      try {
        await this.awaitAndComplete(runId, container, onBytes, store, broadcaster);
      } finally {
        await titleWatcher.stop();
        await this.stopRunObservers(observers);
        limitMonitor.stop();
        runtimeWatcher.stop();
      }
    } catch (err) {
      if (err instanceof ContinueNotEligibleError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] continue error: ${msg}\n`));
      this.deps.runs.markFinished(runId, { state: 'failed', error: `continue failed: ${msg}` });
      this.publishState(runId);
      this.active.delete(runId); this.lastFiles.delete(runId);
      store.close(); broadcaster.end(); this.deps.streams.release(runId);
    }
  }

  /**
   * Builds a LimitMonitor that nudges Claude to exit when its in-TUI
   * rate-limit message appears. Newer Claude Code wordings ("You've hit your
   * limit · resets <time>") display the limit in-TUI without exiting, so the
   * container waits forever and the existing classify()-at-exit flow never
   * runs. Claude Code's TUI requires a *double* Ctrl-C to actually exit — a
   * single 0x03 just clears/confirms. nudgeClaudeToExit handles the double-
   * tap so supervisor.sh can still commit+push the WIP, and SIGKILL is the
   * 30s last-resort fallback.
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
        nudgeClaudeToExit({
          writeStdin: (b) => attach.write(Buffer.from(b)),
          killContainer: () => container.kill().then(() => undefined),
          log: (msg) => onBytes(Buffer.from(msg)),
        });
      },
    });
  }

  private clearRuntimeSentinels(runId: number): void {
    const dir = this.stateDirFor(runId);
    fs.rmSync(path.join(dir, 'waiting'), { force: true });
    fs.rmSync(path.join(dir, 'prompted'), { force: true });
  }

  private makeRuntimeStateWatcher(runId: number): RuntimeStateWatcher {
    const stateDir = this.stateDirFor(runId);
    return new RuntimeStateWatcher({
      waitingPath: `${stateDir}/waiting`,
      promptedPath: `${stateDir}/prompted`,
      onChange: (state: DerivedRuntimeState) => {
        // 'starting' is set explicitly at launch sites — the watcher only
        // needs to drive the running/waiting transitions. The DB guards on
        // markRunning / markWaiting allow them from 'starting' too, so
        // there's no separate "first transition out of starting" branch.
        if (state === 'running') {
          this.deps.runs.markRunning(runId);
          this.publishState(runId);
        } else if (state === 'waiting') {
          this.deps.runs.markWaiting(runId);
          this.publishState(runId);
        }
      },
    });
  }

  // Active run bookkeeping.
  private active = new Map<
    number,
    { container: Docker.Container; attachStream: NodeJS.ReadWriteStream }
  >();
  private lastRateLimit = new Map<number, RateLimitSnapshot>();
  private lastFiles = new Map<number, FilesPayload>();

  /** Forward stdin bytes from the UI to the container. */
  writeStdin(runId: number, bytes: Uint8Array): void {
    const a = this.active.get(runId);
    if (!a) return;
    a.attachStream.write(Buffer.from(bytes));
  }

  async execHistoryOp(runId: number, op: HistoryOp): Promise<ParsedOpResult> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error('run not found');
    if (!run.branch_name) throw new Error('run has no branch');
    const project = this.deps.projects.get(run.project_id);
    if (!project) throw new Error('project missing');
    const env = buildEnv(runId, run.branch_name, project.default_branch, op, null);

    const active = this.active.get(runId);
    if (active) {
      const scriptContents = fs.readFileSync(HISTORY_OP, 'utf8');
      return runHistoryOpInContainer(active.container, env, { scriptContents });
    }
    // Finished run: transient container.
    return runHistoryOpInTransientContainer({
      docker: this.deps.docker,
      image: 'alpine/git:latest',
      repoUrl: project.repo_url,
      historyOpScriptPath: HISTORY_OP,
      env,
      sshSocket: this.deps.config.hostSshAuthSock,
      safeguardPath: this.wipRepo.path(runId),
      authorName: project.git_author_name ?? this.deps.config.gitAuthorName,
      authorEmail: project.git_author_email ?? this.deps.config.gitAuthorEmail,
    });
  }

  /** Spawn a sub-run for merge-conflict resolution or commit polish.
   *  Inherits parent's project + branch; launches normally via launch(). */
  async spawnSubRun(parentRunId: number, kind: 'merge-conflict' | 'polish', argsJson: string): Promise<number> {
    const parent = this.deps.runs.get(parentRunId);
    if (!parent) throw new Error(`parent run ${parentRunId} not found`);
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const prompt = renderSubRunPrompt(kind, args);
    const child = this.deps.runs.create({
      project_id: parent.project_id,
      prompt,
      branch_hint: parent.branch_name || undefined,
      log_path_tmpl: (id) => path.join(this.deps.config.runsDir, `${id}.log`),
      parent_run_id: parent.id,
      kind,
      kind_args_json: argsJson,
    });
    // Fire-and-forget — matches POST /api/projects/:id/runs pattern.
    void this.launch(child.id).catch(() => {
      // swallow — the sub-run's log will record the failure
    });
    return child.id;
  }

  /** Run a command inside the container backing `runId`. Throws if no
   *  container is active for this run. Used by API routes that need on-demand
   *  git output (e.g. per-file diffs). */
  async execInContainer(runId: number, cmd: string[], opts: DockerExecOptions = {}): Promise<DockerExecResult> {
    const a = this.active.get(runId);
    if (!a) throw new Error('container not active');
    return dockerExec(a.container, cmd, opts);
  }

  /** Resize the container's TTY. */
  async resize(runId: number, cols: number, rows: number): Promise<void> {
    const a = this.active.get(runId);
    if (!a) return;
    await a.container.resize({ w: cols, h: rows }).catch(() => {});
    this.deps.streams.getScreen(runId)?.resize(cols, rows);
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

  /**
   * Delete a non-running run: remove the DB row, its log file, and the wip
   * repo. Safe to call only on terminal-state runs (cancelled/failed/
   * succeeded); callers must cancel first if the run is active.
   */
  deleteRun(runId: number): void {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    try { fs.unlinkSync(run.log_path); } catch { /* noop */ }
    this.wipRepo.remove(runId);
    this.deps.runs.delete(runId);
  }

  async rehydrateSchedules(): Promise<void> {
    await this.scheduler.rehydrate();
  }

  /**
   * Called at startup. For each run in state='running', try to reattach; if
   * the container is gone, mark the run failed.
   */
  async recover(): Promise<void> {
    const live = [
      ...this.deps.runs.listByState('starting'),
      ...this.deps.runs.listByState('running'),
      ...this.deps.runs.listByState('waiting'),
    ];
    for (const run of live) {
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
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = makeOnBytes(store, broadcaster, screen);

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
    const runtimeWatcher = this.makeRuntimeStateWatcher(runId);
    const sinceSec = Math.floor((run.started_at ?? Date.now()) / 1000);
    const logsStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      since: sinceSec,
    })) as unknown as NodeJS.ReadableStream;
    logsStream.on('data', (c: Buffer) => { limitMonitor.feedLog(c); onBytes(c); });
    limitMonitor.start();
    runtimeWatcher.start();
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
        this.lastRateLimit.set(runId, snapshot);
        if (snapshot.reset_at != null) {
          this.deps.runs.updateLastLimitResetAt(runId, snapshot.reset_at);
        }
        // No global rate_limit_state write; poller owns that.
      },
      onError: () => { this.deps.usage.bumpParseErrors(runId); },
    });
    tailer.start();
    const titleWatcher = new TitleWatcher({
      path: `${this.stateDirFor(runId)}/session-name`,
      pollMs: 1000,
      onTitle: (t) => this.publishTitleUpdate(runId, t),
      onError: () => { /* swallow — best effort */ },
    });
    titleWatcher.start();
    const observers = await this.startRunObservers(runId, run.branch_name ?? null, events);

    try {
      const waitRes = await container.wait();
      const inspect = await container.inspect().catch(() => null);
      const oomKilled = Boolean(inspect?.State?.OOMKilled);
      const wasCancelled = this.cancelled.delete(runId);
      const resultText = await readFileFromContainer(
        container,
        '/tmp/result.json'
      ).catch(() => '');
      const classification = classifyResultJson(resultText);
      const parsed = parseResultJson(resultText);

      // Capture Claude's session id from the mount dir — same post-mortem
      // scan that launch()'s awaitAndComplete runs. Without this, any run
      // that outlived an orchestrator restart loses its session id and
      // cannot be continued later.
      const sessionId = scanSessionId(this.mountDirFor(runId));
      if (sessionId) this.deps.runs.setClaudeSessionId(runId, sessionId);

      // Resume-restore failure: set resume_failed state and bail out early.
      if (classification.kind === 'resume_failed') {
        const errMsg = `restore failed (${classification.error})`;
        this.deps.runs.markResumeFailed(runId, errMsg);
        this.publishState(runId);
        await container.remove({ force: true, v: true }).catch(() => {});
        return;
      }

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
      if (parsed?.title) {
        this.publishTitleUpdate(runId, parsed.title);
      }

      await container.remove({ force: true, v: true }).catch(() => {});
    } finally {
      await tailer.stop();
      await titleWatcher.stop();
      await this.stopRunObservers(observers);
      limitMonitor.stop();
      runtimeWatcher.stop();
      events.end();
      this.active.delete(runId); this.lastFiles.delete(runId);
      this.lastRateLimit.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
  }
}

function renderSubRunPrompt(kind: 'merge-conflict' | 'polish', args: Record<string, unknown>): string {
  const branch = String(args.branch ?? '');
  const def = String(args.default ?? 'main');
  const strategy = String(args.strategy ?? 'merge');
  if (kind === 'merge-conflict') {
    return (
      `Resolve a merge conflict and complete the merge.\n` +
      `Branch: ${branch}\nTarget: ${def}\nStrategy: ${strategy}\n\n` +
      `Steps:\n` +
      `1. git fetch origin\n` +
      `2. git checkout ${def}\n` +
      `3. git pull --ff-only origin ${def}\n` +
      `4. git merge --no-ff ${branch}  (or --squash / rebase per strategy)\n` +
      `5. If conflicts: resolve them, git add, git commit.\n` +
      `6. git push origin ${def}\n` +
      `Report the final SHA when done.`
    );
  }
  // polish
  return (
    `Polish the commits on branch ${branch}.\n\n` +
    `Use git interactive rebase (GIT_SEQUENCE_EDITOR=cat git rebase -i origin/${def}) to:\n` +
    `  1. Rewrite each commit's subject as a concise conventional-commits style summary.\n` +
    `  2. Ensure each commit body explains the "why" (not just the "what").\n` +
    `  3. Combine trivially-related "wip:" or "fix:" commits where appropriate.\n` +
    `DO NOT change code — only commit metadata.\n\n` +
    `Then: git push --force-with-lease origin ${branch}.\n` +
    `Write a one-line summary of what you did to /fbi-state/session-name.`
  );
}

// Bind-mount OAuth tokens. On Linux they live in ~/.claude/.credentials.json;
// macOS uses Keychain so nothing to mount. ~/.claude.json is injected separately
// (see buildContainerClaudeJson) so we can strip host-specific fields.
function claudeAuthMounts(hostClaudeDir: string, hostBindClaudeDir: string): string[] {
  const localCreds = path.join(hostClaudeDir, '.credentials.json');
  if (!fs.existsSync(localCreds)) return [];
  const bindSource = path.join(hostBindClaudeDir, '.credentials.json');
  return [`${bindSource}:/home/agent/.claude/.credentials.json`];
}

// Forward the host docker socket so agents can run docker/compose commands.
// Paired with HostConfig.GroupAdd on the host's docker GID so the non-root
// `agent` user in the container has rw access without running as root.
function dockerSocketMounts(hostSocket: string): string[] {
  if (!hostSocket) return [];
  return fs.existsSync(hostSocket)
    ? [`${hostSocket}:/var/run/docker.sock`]
    : [];
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

// Claude Code's Stop and UserPromptSubmit events to two /fbi-state/ sentinel
// files that RuntimeStateWatcher polls. Stop creates /fbi-state/waiting
// (turn ended). UserPromptSubmit removes /fbi-state/waiting (user replied)
// AND creates /fbi-state/prompted (sticky — Claude has accepted at least
// one prompt this container, so it's past the launch gap). Derived state:
//   waiting present                  -> 'waiting'
//   waiting absent, prompted present -> 'running'
//   both absent                      -> 'starting'
export function buildClaudeSettingsJson(): string {
  return JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'touch /fbi-state/waiting', timeout: 5 }] },
      ],
      UserPromptSubmit: [
        { hooks: [{
          type: 'command',
          command: 'rm -f /fbi-state/waiting && touch /fbi-state/prompted',
          timeout: 5,
        }] },
      ],
    },
  });
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
