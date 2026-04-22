import Docker from 'dockerode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
}

export class Orchestrator {
  private imageBuilder: ImageBuilder;
  private gcTimer: NodeJS.Timeout | null = null;
  private gc: ImageGc;

  constructor(private deps: OrchestratorDeps) {
    this.imageBuilder = new ImageBuilder(deps.docker);
    this.gc = new ImageGc(this.deps.docker, () => ({ always: ALWAYS, postbuild: POSTBUILD }));
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

    try {
      // Build or reuse image.
      onBytes(Buffer.from(`[fbi] resolving image\n`));
      const devcontainerFile = await fetchDevcontainerFile(
        project.repo_url,
        this.deps.config.hostSshAuthSock,
        onBytes,
      );
      const imageTag = await this.imageBuilder.resolve({
        projectId: project.id,
        devcontainerFile,
        overrideJson: project.devcontainer_override_json,
        onLog: onBytes,
      });
      onBytes(Buffer.from(`[fbi] image: ${imageTag}\n`));

      // Prepare auth + secrets + prompt files.
      const auth: GitAuth = new SshAgentForwarding(this.deps.config.hostSshAuthSock);
      const projectSecrets = this.deps.secrets.decryptAll(project.id);
      const authorName = project.git_author_name ?? this.deps.config.gitAuthorName;
      const authorEmail = project.git_author_email ?? this.deps.config.gitAuthorEmail;

      // Plugins: global defaults + per-project additions (dedup, preserve order).
      const settingsData = this.deps.settings.get();
      const marketplaces = uniq([
        ...settingsData.global_marketplaces,
        ...project.marketplaces,
      ]);
      const plugins = uniq([
        ...settingsData.global_plugins,
        ...project.plugins,
      ]);

      onBytes(Buffer.from(`[fbi] starting container\n`));
      const memMb = project.mem_mb ?? this.deps.config.containerMemMb;
      const cpus = project.cpus ?? this.deps.config.containerCpus;
      const pids = project.pids_limit ?? this.deps.config.containerPids;
      const container = await this.deps.docker.createContainer({
        Image: imageTag,
        name: `fbi-run-${runId}`,
        User: 'agent',
        Env: [
          `RUN_ID=${runId}`,
          `REPO_URL=${project.repo_url}`,
          `DEFAULT_BRANCH=${project.default_branch}`,
          `GIT_AUTHOR_NAME=${authorName}`,
          `GIT_AUTHOR_EMAIL=${authorEmail}`,
          `FBI_MARKETPLACES=${marketplaces.join('\n')}`,
          `FBI_PLUGINS=${plugins.join('\n')}`,
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
            // Just the auth files — not the whole ~/.claude dir — so each
            // container gets clean plugin/session state but stays logged in.
            ...claudeAuthMounts(this.deps.config.hostClaudeDir),
            ...auth.mounts().map((m) =>
              `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
            ),
          ],
        },
      });

      // Inject prompt files directly into the container filesystem so we
      // don't depend on directory bind mounts (which fail silently on some hosts).
      const globalPrompt = this.deps.settings.get().global_prompt;
      await injectFiles(container, '/fbi', {
        'prompt.txt': run.prompt ?? '',
        'instructions.txt': project.instructions ?? '',
        'global.txt': globalPrompt,
        'preamble.txt': preamble,
      });

      // Inject a sanitized ~/.claude.json: strip the host-specific installMethod
      // so Claude doesn't warn about missing /home/agent/.local/bin/claude
      // (host installed via curl, container uses npm). Also injects MCP server config.
      const effectiveMcps = this.deps.mcpServers.listEffective(project.id);
      const claudeJson = buildContainerClaudeJson(
        this.deps.config.hostClaudeDir,
        effectiveMcps,
        projectSecrets,
      );
      await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);

      const attach = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });
      attach.on('data', (c: Buffer) => onBytes(c));

      await container.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markStarted(runId, container.id);

      // Wait for exit.
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
      onBytes(Buffer.from(`\n[fbi] run ${state}\n`));
      await container.remove({ force: true, v: true }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] error: ${msg}\n`));
      this.deps.runs.markFinished(runId, {
        state: 'failed',
        error: msg,
      });
    } finally {
      this.active.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
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
    const a = this.active.get(runId);
    if (!a) return;
    await a.container.stop({ t: 10 }).catch(() => {});
    // the launch() loop observes wait() resolving and handles teardown;
    // mark intent here so it classifies state correctly.
    this.cancelled.add(runId);
  }

  private cancelled = new Set<number>();

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

    // Output: follow container.logs from where we left off.
    const sinceSec = Math.floor((run.started_at ?? Date.now()) / 1000);
    const logsStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      since: sinceSec,
    })) as unknown as NodeJS.ReadableStream;
    logsStream.on('data', (c: Buffer) => onBytes(c));

    // Stdin: fresh attach with only stdin.
    const attachStream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    });
    this.active.set(runId, { container, attachStream });

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
    this.active.delete(runId);
    store.close();
    broadcaster.end();
    this.deps.streams.release(runId);
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
): Promise<string | null> {
  if (!sshAuthSock) return null;
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-dc-'));
  const tmp = path.join(tmpParent, 'r');
  try {
    const env = { ...process.env, SSH_AUTH_SOCK: sshAuthSock, GIT_TERMINAL_PROMPT: '0' };
    execFileSync(
      'git',
      ['clone', '--depth=1', '--filter=blob:none', '--sparse', '--no-tags', repoUrl, tmp],
      { env, stdio: 'pipe' }
    );
    execFileSync('git', ['-C', tmp, 'sparse-checkout', 'set', '.devcontainer'], { env, stdio: 'pipe' });
    execFileSync('git', ['-C', tmp, 'checkout'], { env, stdio: 'pipe' });
    const dcFile = path.join(tmp, '.devcontainer', 'devcontainer.json');
    if (fs.existsSync(dcFile)) {
      onLog(Buffer.from(`[fbi] using repo .devcontainer/devcontainer.json\n`));
      return fs.readFileSync(dcFile, 'utf8');
    }
    return null;
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
