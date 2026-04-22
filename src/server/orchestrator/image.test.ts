import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import { ImageBuilder } from './image.js';

const docker = new Docker();
const HAVE_DOCKER = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

describe.skipIf(!HAVE_DOCKER)('ImageBuilder', () => {
  it('builds a fallback image and returns a stable tag', async () => {
    const builder = new ImageBuilder(docker);
    const tag = await builder.resolve({
      projectId: 999,
      devcontainerFile: null,
      overrideJson: JSON.stringify({
        base: 'alpine:3.19',
        apt: [],
        env: {},
      }),
      onLog: () => {},
    });
    expect(tag).toMatch(/^fbi\/p999:[0-9a-f]{16}$/);
    const img = await docker.getImage(tag).inspect();
    expect(img.Id).toBeDefined();
    await docker.getImage(tag).remove({ force: true }).catch(() => {});
  }, 120_000);

  it('returns cached tag on second call with same input', async () => {
    const builder = new ImageBuilder(docker);
    const input = {
      projectId: 998,
      devcontainerFile: null,
      overrideJson: JSON.stringify({ base: 'alpine:3.19', apt: [], env: {} }),
      onLog: () => {},
    };
    const tag1 = await builder.resolve(input);
    const t0 = Date.now();
    const tag2 = await builder.resolve(input);
    expect(tag1).toBe(tag2);
    expect(Date.now() - t0).toBeLessThan(2000); // cache hit is fast
    await docker.getImage(tag1).remove({ force: true }).catch(() => {});
  }, 180_000);
});
