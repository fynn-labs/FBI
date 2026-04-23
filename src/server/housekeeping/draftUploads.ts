import fsp from 'node:fs/promises';
import path from 'node:path';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export async function sweepDraftUploads(draftDir: string, now: number): Promise<void> {
  let tokens: string[];
  try {
    tokens = await fsp.readdir(draftDir);
  } catch {
    return;
  }
  for (const token of tokens) {
    const full = path.join(draftDir, token);
    try {
      const st = await fsp.stat(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs >= DRAFT_TTL_MS) {
        await fsp.rm(full, { recursive: true, force: true });
      }
    } catch {
      /* noop */
    }
  }
}

export async function sweepPartFiles(runsDir: string, draftDir: string): Promise<void> {
  await sweepPartFilesUnder(draftDir);
  try {
    const runs = await fsp.readdir(runsDir);
    for (const r of runs) {
      const uploads = path.join(runsDir, r, 'uploads');
      await sweepPartFilesIn(uploads);
    }
  } catch {
    /* noop */
  }
}

async function sweepPartFilesUnder(root: string): Promise<void> {
  let subs: string[];
  try {
    subs = await fsp.readdir(root);
  } catch {
    return;
  }
  for (const s of subs) {
    await sweepPartFilesIn(path.join(root, s));
  }
}

async function sweepPartFilesIn(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('.part')) continue;
    await fsp.unlink(path.join(dir, n)).catch(() => {});
  }
}

export interface StartDraftUploadsGcOpts {
  runsDir: string;
  draftDir: string;
  intervalMs?: number;
  now?: () => number;
}

export function startDraftUploadsGc(opts: StartDraftUploadsGcOpts): () => void {
  const interval = opts.intervalMs ?? 60 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());

  void (async () => {
    await sweepPartFiles(opts.runsDir, opts.draftDir);
    await sweepDraftUploads(opts.draftDir, now());
  })();

  const t = setInterval(() => {
    void sweepDraftUploads(opts.draftDir, now());
  }, interval);
  t.unref?.();

  return () => clearInterval(t);
}
