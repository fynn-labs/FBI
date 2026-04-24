export interface ModelParamFields {
  model: string | null;
  effort: string | null;
  subagent_model: string | null;
}

export function modelParamEnvEntries(run: ModelParamFields): string[] {
  const entries: string[] = [];
  if (run.model) entries.push(`ANTHROPIC_MODEL=${run.model}`);
  if (run.effort) entries.push(`CLAUDE_CODE_EFFORT_LEVEL=${run.effort}`);
  if (run.subagent_model) entries.push(`CLAUDE_CODE_SUBAGENT_MODEL=${run.subagent_model}`);
  return entries;
}
