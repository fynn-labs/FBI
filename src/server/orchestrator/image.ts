import type Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import tar from 'tar-stream';
import { computeConfigHash } from './configHash.js';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSTBUILD = fs.readFileSync(path.join(HERE, 'postbuild.sh'), 'utf8');
const DOCKERFILE_TMPL = fs.readFileSync(path.join(HERE, 'Dockerfile.tmpl'), 'utf8');

const ALWAYS = ['git', 'openssh-client', 'gh', 'ca-certificates', 'claude-cli'];

export interface ResolveInput {
  projectId: number;
  devcontainerFile: string | null;   // raw JSON contents if repo has one
  overrideJson: string | null;        // projects.devcontainer_override_json
  onLog: (chunk: Uint8Array) => void; // build logs
}

interface OverrideConfig {
  base?: string;
  apt?: string[];
  env?: Record<string, string>;
}

export class ImageBuilder {
  constructor(private docker: Docker) {}

  async resolve(input: ResolveInput): Promise<string> {
    const hash = computeConfigHash({
      devcontainer_file: input.devcontainerFile,
      override_json: input.overrideJson,
      always: ALWAYS,
    });
    const finalTag = `fbi/p${input.projectId}:${hash}`;

    if (await this.imageExists(finalTag)) return finalTag;

    // Stage 1: build the base image (either devcontainer or fallback template).
    const baseTag = `fbi/p${input.projectId}-base:${hash}`;
    if (!(await this.imageExists(baseTag))) {
      if (input.devcontainerFile) {
        await this.buildDevcontainer(input.devcontainerFile, baseTag, input.onLog);
      } else {
        await this.buildFallback(input.overrideJson, baseTag, input.onLog);
      }
    }

    // Stage 2: apply the FBI post-build layer on top.
    await this.buildPostLayer(baseTag, finalTag, input.onLog);
    return finalTag;
  }

  private async imageExists(tag: string): Promise<boolean> {
    try {
      await this.docker.getImage(tag).inspect();
      return true;
    } catch {
      return false;
    }
  }

  private renderFallbackDockerfile(overrideJson: string | null): string {
    const cfg: OverrideConfig = overrideJson ? JSON.parse(overrideJson) : {};
    const base = cfg.base ?? 'ubuntu:24.04';
    const apt = (cfg.apt ?? []).join(' ');
    const envLines = Object.entries(cfg.env ?? {})
      .map(([k, v]) => `ENV ${k}=${JSON.stringify(v)}`)
      .join('\n');
    return DOCKERFILE_TMPL
      .replaceAll('__BASE_IMAGE__', base)
      .replaceAll('__APT_PACKAGES__', apt)
      .replaceAll('__ENV_EXPORTS__', envLines);
  }

  private async buildFallback(
    overrideJson: string | null,
    tag: string,
    onLog: (c: Uint8Array) => void
  ): Promise<void> {
    const dockerfile = this.renderFallbackDockerfile(overrideJson);
    const context = createTarContext({ Dockerfile: dockerfile });
    const stream = await this.docker.buildImage(context, { t: tag, rm: true });
    await this.followBuild(stream, onLog);
  }

  private async buildDevcontainer(
    devcontainerFileContents: string,
    tag: string,
    onLog: (c: Uint8Array) => void
  ): Promise<void> {
    // Write the file to a tmp dir and shell out to @devcontainers/cli.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-dc-'));
    fs.mkdirSync(path.join(tmp, '.devcontainer'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.devcontainer', 'devcontainer.json'),
      devcontainerFileContents
    );
    try {
      const out = execFileSync(
        'npx',
        [
          '-y',
          '@devcontainers/cli@0.67.0',
          'build',
          '--workspace-folder', tmp,
          '--image-name', tag,
        ],
        { encoding: 'buffer' }
      );
      onLog(out);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async buildPostLayer(
    baseTag: string,
    finalTag: string,
    onLog: (c: Uint8Array) => void
  ): Promise<void> {
    const dockerfile = [
      `FROM ${baseTag}`,
      `USER root`,
      `COPY postbuild.sh /tmp/postbuild.sh`,
      `RUN bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh`,
      `USER agent`,
      `WORKDIR /workspace`,
    ].join('\n');
    const context = createTarContext({
      Dockerfile: dockerfile,
      'postbuild.sh': POSTBUILD,
    });
    const stream = await this.docker.buildImage(context, { t: finalTag, rm: true });
    await this.followBuild(stream, onLog);
  }

  private followBuild(
    stream: NodeJS.ReadableStream,
    onLog: (c: Uint8Array) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { stream?: string; error?: string }) => {
          if (event.error) return; // final handler reports
          if (event.stream) onLog(Buffer.from(event.stream));
        }
      );
    });
  }
}

function createTarContext(files: Record<string, string>): NodeJS.ReadableStream {
  const pack = tar.pack();
  for (const [name, contents] of Object.entries(files)) {
    pack.entry({ name, mode: 0o644 }, contents);
  }
  pack.finalize();
  return pack;
}
