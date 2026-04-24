export type ModelAlias = 'sonnet' | 'opus' | 'haiku';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelParams {
  model?: ModelAlias;
  effort?: EffortLevel;
  subagent_model?: ModelAlias;
}

const MODELS: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku']);
const EFFORTS: ReadonlySet<string> = new Set([
  'low', 'medium', 'high', 'xhigh', 'max',
]);

export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

export function validateModelParams(p: {
  model?: string | null;
  effort?: string | null;
  subagent_model?: string | null;
}): ValidationResult {
  // Treat null and undefined identically as "not provided". This matches how
  // the client may serialize an unset value (either dropped or explicit null).
  const model = p.model ?? undefined;
  const effort = p.effort ?? undefined;
  const subagent = p.subagent_model ?? undefined;

  if (model !== undefined && !MODELS.has(model)) {
    return { ok: false, message: `invalid model: ${model}` };
  }
  if (effort !== undefined && !EFFORTS.has(effort)) {
    return { ok: false, message: `invalid effort: ${effort}` };
  }
  if (subagent !== undefined && !MODELS.has(subagent)) {
    return { ok: false, message: `invalid subagent_model: ${subagent}` };
  }
  if (effort !== undefined && model === 'haiku') {
    return { ok: false, message: 'effort is not supported on haiku' };
  }
  if (effort === 'xhigh' && model !== undefined && model !== 'opus') {
    return { ok: false, message: 'xhigh effort is only supported on opus' };
  }
  return { ok: true };
}
