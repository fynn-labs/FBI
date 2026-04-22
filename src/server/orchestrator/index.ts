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

      const runTmpDir = fs.mkdtempSync(path.join('/tmp', 'fbi-run-'));
      fs.writeFileSync(path.join(runTmpDir, 'prompt.txt'), run.prompt);
      fs.writeFileSync(
        path.join(runTmpDir, 'instructions.txt'),
        project.instructions ?? ''
      );

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
            `${this.deps.config.hostClaudeDir}:/home/agent/.claude:ro`,
            `${runTmpDir}:/run/fbi:ro`,
            ...auth.mounts().map((m) =>
              `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
            ),
          ],
        },
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
      this.deps.runs.markStarted(runId, container.id);

      // Wait for exit.
      const waitRes = await container.wait();
      const resultText = await readFileFromContainer(
        container,
        '/tmp/result.json'
      ).catch(() => '');
      const parsed = parseResultJson(resultText);

      const state =
        waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0
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
      fs.rmSync(runTmpDir, { recursive: true, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] error: ${msg}\n`));
      this.deps.runs.markFinished(runId, {
        state: 'failed',
        error: msg,
      });
    } finally {
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
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
