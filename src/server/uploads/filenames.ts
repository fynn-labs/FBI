import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_FILENAME_BYTES = 255;

export function sanitizeFilename(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('invalid_filename');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('invalid_filename');
  }
  if (name === '.' || name === '..' || name.startsWith('..')) {
    throw new Error('invalid_filename');
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_FILENAME_BYTES) {
    throw new Error('invalid_filename');
  }
  return name;
}

export function resolveFilename(dir: string, incoming: string): string {
  const base = sanitizeFilename(incoming);
  const existing = new Set<string>();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.part')) existing.add(f);
    }
  } catch {
    return base;
  }
  if (!existing.has(base)) return base;
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 1; i < 10_000; i++) {
    const candidate = ext ? `${stem} (${i})${ext}` : `${stem} (${i})`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('collision_overflow');
}

export async function directoryBytes(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let sum = 0;
  for (const name of entries) {
    if (name.endsWith('.part')) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) sum += st.size;
    } catch {
      /* ignore stat errors */
    }
  }
  return sum;
}
