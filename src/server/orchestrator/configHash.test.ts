import { describe, it, expect } from 'vitest';
import { computeConfigHash } from './configHash.js';

describe('computeConfigHash', () => {
  it('is stable for the same inputs', () => {
    const a = computeConfigHash({
      devcontainer_files: { 'devcontainer.json': '{"image":"node:20"}' },
      override_json: null,
      always: ['git'],
      postbuild: 'echo hi',
    });
    const b = computeConfigHash({
      devcontainer_files: { 'devcontainer.json': '{"image":"node:20"}' },
      override_json: null,
      always: ['git'],
      postbuild: 'echo hi',
    });
    expect(a).toBe(b);
  });

  it('changes when devcontainer file changes', () => {
    const a = computeConfigHash({
      devcontainer_files: { 'devcontainer.json': '{"image":"node:20"}' }, override_json: null, always: [], postbuild: '',
    });
    const b = computeConfigHash({
      devcontainer_files: { 'devcontainer.json': '{"image":"node:22"}' }, override_json: null, always: [], postbuild: '',
    });
    expect(a).not.toBe(b);
  });

  it('changes when override changes', () => {
    const a = computeConfigHash({
      devcontainer_files: null, override_json: '{"apt":["ripgrep"]}', always: [], postbuild: '',
    });
    const b = computeConfigHash({
      devcontainer_files: null, override_json: '{"apt":["jq"]}', always: [], postbuild: '',
    });
    expect(a).not.toBe(b);
  });

  it('is independent of always[] ordering', () => {
    const a = computeConfigHash({
      devcontainer_files: null, override_json: null, always: ['a', 'b'], postbuild: '',
    });
    const b = computeConfigHash({
      devcontainer_files: null, override_json: null, always: ['b', 'a'], postbuild: '',
    });
    expect(a).toBe(b);
  });

  it('produces 16 hex chars', () => {
    const h = computeConfigHash({
      devcontainer_files: null, override_json: null, always: [], postbuild: '',
    });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
