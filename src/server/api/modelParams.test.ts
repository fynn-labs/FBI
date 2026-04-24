import { describe, it, expect } from 'vitest';
import { validateModelParams } from './modelParams.js';

describe('validateModelParams', () => {
  it('accepts all fields absent', () => {
    expect(validateModelParams({}).ok).toBe(true);
  });

  it.each([
    { model: 'sonnet' as const },
    { model: 'opus' as const },
    { model: 'haiku' as const },
    { effort: 'low' as const },
    { effort: 'medium' as const },
    { effort: 'high' as const },
    { effort: 'max' as const },
    { subagent_model: 'sonnet' as const },
    { model: 'opus' as const, effort: 'xhigh' as const, subagent_model: 'haiku' as const },
    { model: 'sonnet' as const, effort: 'max' as const },
    { effort: 'high' as const },
  ])('accepts valid combination %o', (input) => {
    const r = validateModelParams(input);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown model', () => {
    const r = validateModelParams({ model: 'turbo' as unknown as 'sonnet' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/model/);
  });

  it('rejects unknown effort', () => {
    const r = validateModelParams({ effort: 'enormous' as unknown as 'max' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown subagent_model', () => {
    const r = validateModelParams({ subagent_model: 'mini' as unknown as 'haiku' });
    expect(r.ok).toBe(false);
  });

  it('rejects effort + haiku', () => {
    const r = validateModelParams({ model: 'haiku', effort: 'high' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/haiku/i);
  });

  it('rejects xhigh + sonnet', () => {
    const r = validateModelParams({ model: 'sonnet', effort: 'xhigh' as 'max' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/xhigh/i);
  });

  it('rejects xhigh + haiku (haiku rule wins first)', () => {
    const r = validateModelParams({ model: 'haiku', effort: 'xhigh' as 'max' });
    expect(r.ok).toBe(false);
  });

  it('accepts xhigh + opus', () => {
    const r = validateModelParams({ model: 'opus', effort: 'xhigh' });
    expect(r.ok).toBe(true);
  });

  it('accepts effort without model (model absent)', () => {
    // Server-side is permissive; UI prevents odd combos, server ignores unset model.
    const r = validateModelParams({ effort: 'high' });
    expect(r.ok).toBe(true);
  });

  it('treats null values identically to undefined', () => {
    expect(validateModelParams({ model: null, effort: null, subagent_model: null }).ok).toBe(true);
    expect(validateModelParams({ model: 'opus', effort: null, subagent_model: null }).ok).toBe(true);
  });
});
