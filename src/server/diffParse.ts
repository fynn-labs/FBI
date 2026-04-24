import type { FileDiffPayload, FileDiffHunk } from '../shared/types.js';

export function parseUnifiedDiff(raw: string, path: string, ref: string): FileDiffPayload {
  const MAX = 256 * 1024;
  const truncated = raw.length > MAX;
  const body = truncated ? raw.slice(0, MAX) : raw;
  const hunks: FileDiffHunk[] = [];
  let current: FileDiffHunk | null = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.lines.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-') && !line.startsWith('---')) current.lines.push({ kind: 'del', text: line.slice(1) });
    else if (line.startsWith(' ')) current.lines.push({ kind: 'ctx', text: line.slice(1) });
  }
  return { path, ref: ref === 'worktree' ? 'worktree' : ref, hunks, truncated };
}
