// Claude Code's TUI input prompt, rendered once the assistant has finished its
// turn. Two TUI eras are supported:
//
//   - Claude Code 2.x draws the prompt as "❯ " (U+276F) inside a multi-line
//     input box; below the prompt line the TUI emits padding rows, a
//     horizontal "────" separator, and a hint/tip line — so the prompt is
//     not at end-of-buffer and must be detected wherever it appears in the
//     recent tail. "❯" is unique to the input prompt in Claude's TUI, so
//     matching on it at line start does not false-match transcript text.
//
//   - Legacy Claude Code drew "│ > " or bare "> " with nothing after the
//     prompt marker on that line. Kept anchored to end-of-buffer to preserve
//     the original invariant (no false match on mid-turn ">" like "3 > 2").
const WAITING_PROMPT_RES: ReadonlyArray<RegExp> = [
  /(^|\n)[ \t]*❯/,                 // Claude Code 2.x
  /(^|\n)[ \t]*[│|][ \t]*>[ \t]*$/,     // legacy bordered
  /(^|\n)[ \t]*>[ \t]*$/,               // legacy bare
];

export function containsWaitingPrompt(stripped: string): boolean {
  // The legacy patterns anchor to $, so trim trailing whitespace + braille
  // blank padding to land on a real final char. The "❯" pattern doesn't
  // anchor, so trimming is a no-op for it.
  const trimmed = stripped.replace(/[\s⠀]+$/u, '');
  return WAITING_PROMPT_RES.some((re) => re.test(trimmed));
}
