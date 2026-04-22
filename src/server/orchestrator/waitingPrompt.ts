// Claude Code's TUI input prompt, rendered once the assistant has finished its
// turn, presents a line that (after ANSI stripping and trimming trailing
// whitespace) ends with "> " — either bare or inside the box border.
//
// We only match when there is nothing after the prompt marker on that line,
// so mid-turn output that happens to contain ">" (e.g. "3 > 2") never matches.
const WAITING_PROMPT_RES: ReadonlyArray<RegExp> = [
  /(^|\n)[ \t]*[│|][ \t]*>[ \t]*$/,
  /(^|\n)[ \t]*>[ \t]*$/,
];

export function containsWaitingPrompt(stripped: string): boolean {
  const trimmed = stripped.replace(/[\s⠀]+$/u, '');
  return WAITING_PROMPT_RES.some((re) => re.test(trimmed));
}
