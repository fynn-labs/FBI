import { describe, it, expect } from 'vitest';
import { computeConfigHash } from './configHash.js';

describe('computeConfigHash', () => {
  it('is stable for the same inputs', () => {
    const a = computeConfigHash({
      devcontainer_file: '{"image":"node:20"}',
      override_json: null,
      always: ['git'],
    });
    const b = computeConfigHash({
      devcontainer_file: '{"image":"node:20"}',
      override_json: null,
      always: ['git'],
    });
    expect(a).toBe(b);
  });

  it('changes when devcontainer file changes', () => {
    const a = computeConfigHash({
      devcontainer_file: '{"image":"node:20"}', override_json: null, always: [],
    });
    const b = computeConfigHash({
      devcontainer_file: '{"image":"node:22"}', override_json: null, always: [],
    });
    expect(a).not.toBe(b);
  });

  it('changes when override changes', () => {
    const a = computeConfigHash({
      devcontainer_file: null, override_json: '{"apt":["ripgrep"]}', always: [],
    });
    const b = computeConfigHash({
      devcontainer_file: null, override_json: '{"apt":["jq"]}', always: [],
    });
    expect(a).not.toBe(b);
  });

  it('is independent of always[] ordering', () => {
    const a = computeConfigHash({
      devcontainer_file: null, override_json: null, always: ['a', 'b'],
    });
    const b = computeConfigHash({
      devcontainer_file: null, override_json: null, always: ['b', 'a'],
    });
    expect(a).toBe(b);
  });

  it('produces 16 hex chars', () => {
    const h = computeConfigHash({
      devcontainer_file: null, override_json: null, always: [],
    });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
