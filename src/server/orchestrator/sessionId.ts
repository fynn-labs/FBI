import fs from 'node:fs';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runMountDir(runsDir: string, runId: number): string {
  return path.join(runsDir, String(runId), 'claude-projects');
}

export function scanSessionId(mountDir: string): string | null {
  let subs: string[];
  try {
    subs = fs.readdirSync(mountDir);
  } catch {
    return null;
  }
  const candidates: Array<{ uuid: string; mtimeMs: number }> = [];
  for (const sub of subs) {
    const subPath = path.join(mountDir, sub);
    let files: string[];
    try {
      files = fs.readdirSync(subPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const base = file.slice(0, -'.jsonl'.length);
      if (!UUID_RE.test(base)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(subPath, file)).mtimeMs;
      } catch {
        continue;
      }
      candidates.push({ uuid: base, mtimeMs });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].uuid;
}
