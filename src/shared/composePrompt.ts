export interface ComposePromptInput {
  preamble: string;
  globalPrompt: string;
  instructions: string;
  runPrompt: string;
}

export function composePrompt(input: ComposePromptInput): string {
  const parts = [input.preamble, input.globalPrompt, input.instructions]
    .filter((s) => s.trim().length > 0);
  parts.push(input.runPrompt);
  return parts.join('\n\n---\n\n');
}
