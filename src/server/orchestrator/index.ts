import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunsRepo } from '../db/runs.js';
import type { ProjectsRepo } from '../db/projects.js';
import type { SecretsRepo } from '../db/secrets.js';
import type { Config } from '../config.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { LogStore } from '../logs/store.js';
import { ImageBuilder } from './image.js';
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
  streams: RunStreamRegistry;
}

export class Orchestrator {
  private imageBuilder: ImageBuilder;

  constructor(private deps: OrchestratorDeps) {
    this.imageBuilder = new ImageBuilder(deps.docker);
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

    try {
      // Build or reuse image.
      onBytes(Buffer.from(`[fbi] resolving image\n`));
      const imageTag = await this.imageBuilder.resolve({
        projectId: project.id,
        devcontainerFile: null, // resolved per-project at repo time; v1 uses override only
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
      const marketplaces = uniq([
        ...this.deps.config.defaultMarketplaces,
        ...project.marketplaces,
      ]);
      const plugins = uniq([
        ...this.deps.config.defaultPlugins,
        ...project.plugins,
      ]);

      onBytes(Buffer.from(`[fbi] starting container\n`));
      const container = await this.deps.docker.createContainer({
        Image: imageTag,
        name: `fbi-run-${runId}`,
        User: 'agent',
        Env: [
          `RUN_ID=${runId}`,
          `REPO_URL=${project.repo_url}`,
          `DEFAULT_BRANCH=${project.default_branch}`,
          `BRANCH_NAME=${run.branch_name}`,
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
          Binds: [
            `${SUPERVISOR}:/usr/local/bin/supervisor.sh:ro`,
            // OAuth credentials live in ~/.claude.json; ~/.claude itself is
            // not mounted so each container gets a clean plugin state.
            ...claudeJsonMount(this.deps.config.hostClaudeDir),
            ...auth.mounts().map((m) =>
              `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
            ),
          ],
        },
      });

      // Inject prompt files directly into the container filesystem so we
      // don't depend on directory bind mounts (which fail silently on some hosts).
      await injectFiles(container, '/fbi', {
        'prompt.txt': run.prompt ?? '',
        'instructions.txt': project.instructions ?? '',
      });

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

      this.deps.runs.markFinished(runId, {
        state,
        exit_code: parsed?.exit_code ?? waitRes.StatusCode,
        head_commit: parsed?.head_sha ?? null,
        error:
          state === 'failed'
            ? parsed
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

    this.deps.runs.markFinished(runId, {
      state,
      exit_code: parsed?.exit_code ?? waitRes.StatusCode,
      head_commit: parsed?.head_sha ?? null,
      error:
        state === 'failed' && parsed
          ? parsed.push_exit !== 0
            ? `git push failed (code ${parsed.push_exit})`
            : `agent exit ${parsed.exit_code}`
          : state === 'failed'
            ? `container exit ${waitRes.StatusCode}`
            : null,
    });

    await container.remove({ force: true, v: true }).catch(() => {});
    this.active.delete(runId);
    store.close();
    broadcaster.end();
    this.deps.streams.release(runId);
  }
}

// Returns a bind-mount string for ~/.claude.json if it exists on the host
// alongside the hostClaudeDir (e.g. /home/fbi/.claude → /home/fbi/.claude.json).
function claudeJsonMount(hostClaudeDir: string): string[] {
  const hostJson = path.join(path.dirname(hostClaudeDir), '.claude.json');
  return fs.existsSync(hostJson)
    ? [`${hostJson}:/home/agent/.claude.json`]
    : [];
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

async function injectFiles(
  container: Docker.Container,
  destDir: string,
  files: Record<string, string>
): Promise<void> {
  const tar = await import('tar-stream');
  const pack = tar.pack();
  for (const [name, contents] of Object.entries(files)) {
    pack.entry({ name, mode: 0o644 }, contents);
  }
  pack.finalize();
  await container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: destDir });
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
