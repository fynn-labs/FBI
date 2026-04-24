import { describe, it, expect } from 'vitest';
import { modelParamEnvEntries } from './modelParamEnv.js';

describe('modelParamEnvEntries', () => {
  it('returns empty array when all three fields are null', () => {
    expect(
      modelParamEnvEntries({ model: null, effort: null, subagent_model: null })
    ).toEqual([]);
  });

  it('emits ANTHROPIC_MODEL when model is set', () => {
    expect(
      modelParamEnvEntries({ model: 'opus', effort: null, subagent_model: null })
    ).toEqual(['ANTHROPIC_MODEL=opus']);
  });

  it('emits CLAUDE_CODE_EFFORT_LEVEL when effort is set', () => {
    expect(
      modelParamEnvEntries({ model: null, effort: 'xhigh', subagent_model: null })
    ).toEqual(['CLAUDE_CODE_EFFORT_LEVEL=xhigh']);
  });

  it('emits CLAUDE_CODE_SUBAGENT_MODEL when subagent_model is set', () => {
    expect(
      modelParamEnvEntries({ model: null, effort: null, subagent_model: 'sonnet' })
    ).toEqual(['CLAUDE_CODE_SUBAGENT_MODEL=sonnet']);
  });

  it('emits all three when all three are set', () => {
    expect(
      modelParamEnvEntries({
        model: 'opus', effort: 'high', subagent_model: 'haiku',
      })
    ).toEqual([
      'ANTHROPIC_MODEL=opus',
      'CLAUDE_CODE_EFFORT_LEVEL=high',
      'CLAUDE_CODE_SUBAGENT_MODEL=haiku',
    ]);
  });
});
