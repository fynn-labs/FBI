import type { Project } from '../../shared/types.js';
import { computeConfigHash } from './configHash.js';

const RETENTION_DAYS = 30;

export interface DockerLike {
  listImages: (opts?: object) => Promise<Array<{ Id: string; RepoTags?: string[] | null; Created: number; Size?: number }>>;
  listContainers: (opts?: { all: boolean }) => Promise<Array<{ Id: string; ImageID: string }>>;
  getImage: (ref: string) => { remove: (opts?: object) => Promise<void> };
}

export interface GcConfig {
  always: string[];
  postbuild: string;
}

export interface SweepResult {
  deletedCount: number;
  deletedBytes: number;
  errors: Array<{ tag: string; message: string }>;
}

export class ImageGc {
  constructor(
    private docker: DockerLike,
    private readConfig: () => GcConfig,
  ) {}

  async sweep(projects: Project[], nowMs: number): Promise<SweepResult> {
    const cfg = this.readConfig();
    const reachable = new Set<string>();
    for (const p of projects) {
      const hash = computeConfigHash({
        devcontainer_files: null,
        override_json: p.devcontainer_override_json,
        always: cfg.always,
        postbuild: cfg.postbuild,
      });
      reachable.add(`fbi/p${p.id}:${hash}`);
      reachable.add(`fbi/p${p.id}-base:${hash}`);
    }

    const containers = await this.docker.listContainers({ all: true });
    const usedImageIds = new Set(containers.map((c) => c.ImageID));

    const cutoffSec = Math.floor(nowMs / 1000) - RETENTION_DAYS * 86400;
    const images = await this.docker.listImages();
    const toDelete: Array<{ tag: string; size: number }> = [];

    for (const img of images) {
      if (usedImageIds.has(img.Id)) continue;
      const tags = img.RepoTags ?? [];
      const fbiTags = tags.filter((t) => t.startsWith('fbi/'));
      if (fbiTags.length === 0) continue;
      if (img.Created > cutoffSec) continue;
      // Only delete if ALL fbi tags on this image are unreachable
      if (fbiTags.every((t) => !reachable.has(t))) {
        for (const t of fbiTags) toDelete.push({ tag: t, size: img.Size ?? 0 });
      }
    }

    const errors: SweepResult['errors'] = [];
    let deletedBytes = 0;
    let deletedCount = 0;
    for (const { tag, size } of toDelete) {
      try {
        await this.docker.getImage(tag).remove({ force: false });
        deletedCount += 1;
        deletedBytes += size;
      } catch (err) {
        errors.push({ tag, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { deletedCount, deletedBytes, errors };
  }
}
