import { describe, it, expect } from 'vitest';
import { ImageGc, type DockerLike } from './imageGc.js';
import { computeConfigHash } from './configHash.js';
import type { Project } from '../../shared/types.js';

function project(id: number, devcontainer: string | null, override: string | null): Project {
  return {
    id, name: `p${id}`, repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: override, instructions: null,
    git_author_name: null, git_author_email: null,
    marketplaces: [], plugins: [],
    mem_mb: null, cpus: null, pids_limit: null,
    created_at: 0, updated_at: 0,
  };
}

function fakeDocker(images: Array<{ id: string; tags: string[]; created: number }>,
  containers: Array<{ id: string; image_id: string }>): DockerLike {
  const removed: string[] = [];
  return {
    listImages: async () => images.map((i) => ({
      Id: i.id, RepoTags: i.tags, Created: i.created, Size: 1024,
    })),
    listContainers: async () => containers.map((c) => ({
      Id: c.id, ImageID: c.image_id,
    })),
    getImage: (ref: string) => ({
      remove: async () => { removed.push(ref); },
    }),
    _removed: removed,
  } as unknown as DockerLike & { _removed: string[] };
}

describe('ImageGc.sweep', () => {
  it('keeps reachable project images', async () => {
    const p = project(1, null, null);
    const hash = computeConfigHash({
      devcontainer_files: null, override_json: null,
      always: [], postbuild: '',
    });
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: [`fbi/p1:${hash}`], created: now - 90 * 86400 }],
      []
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(0);
    expect((docker as any)._removed).toEqual([]);
  });

  it('keeps images referenced by any container even if old', async () => {
    const p = project(1, null, null);
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: ['fbi/p99:orphan'], created: now - 90 * 86400 }],
      [{ id: 'c1', image_id: 'sha1' }]
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(0);
  });

  it('deletes unreachable fbi/ images older than 30 days', async () => {
    const p = project(1, null, null);
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: ['fbi/p99:orphan'], created: now - 31 * 86400 }],
      []
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(1);
    expect((docker as any)._removed).toEqual(['fbi/p99:orphan']);
  });

  it('keeps unreachable fbi/ images newer than 30 days', async () => {
    const p = project(1, null, null);
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: ['fbi/p99:recent'], created: now - 10 * 86400 }],
      []
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(0);
  });

  it('never touches non-fbi images', async () => {
    const p = project(1, null, null);
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: ['ubuntu:24.04', 'node:20'], created: now - 90 * 86400 }],
      []
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(0);
  });
});
