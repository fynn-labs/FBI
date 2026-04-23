import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveFilename } from './filenames.js';

export interface PromoteArgs {
  draftDir: string;
  runsDir: string;
  token: string;
  runId: number;
}

export interface PromotedFile {
  filename: string;
  size: number;
}

export async function promoteDraft(args: PromoteArgs): Promise<PromotedFile[]> {
  const src = path.join(args.draftDir, args.token);
  const dst = path.join(args.runsDir, String(args.runId), 'uploads');
  const entries = await fsp.readdir(src); // throws if token dir missing
  await fsp.mkdir(dst, { recursive: true });
  const out: PromotedFile[] = [];
  for (const name of entries) {
    if (name.endsWith('.part')) continue;
    const finalName = resolveFilename(dst, name);
    const srcPath = path.join(src, name);
    const dstPath = path.join(dst, finalName);
    await fsp.rename(srcPath, dstPath);
    const st = await fsp.stat(dstPath);
    out.push({ filename: finalName, size: st.size });
  }
  await fsp.rm(src, { recursive: true, force: true });
  return out;
}
