import fs from 'node:fs';
import path from 'node:path';

export function sumJsonlSizes(root: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return 0; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) { total += sumJsonlSizes(full); continue; }
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { total += fs.statSync(full).size; } catch { /* missing */ }
    }
  }
  return total;
}
