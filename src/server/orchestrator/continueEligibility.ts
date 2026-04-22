import fs from 'node:fs';
import path from 'node:path';
import type { Run } from '../../shared/types.js';
import { runMountDir } from './sessionId.js';

export type ContinueEligibility =
  | { ok: true }
  | { ok: false; code: 'wrong_state' | 'no_session' | 'session_files_missing'; message: string };

/**
 * Gate for user-initiated "Continue" on a terminated run. Called by the
 * orchestrator before attempting to rehydrate a claude --resume container.
 * Pure: no side effects, no DB access, just fs.existsSync / readdirSync on
 * the per-run session mount directory.
 */
export function checkContinueEligibility(run: Run, runsDir: string): ContinueEligibility {
  if (run.state !== 'failed' && run.state !== 'cancelled' && run.state !== 'succeeded') {
    return {
      ok: false,
      code: 'wrong_state',
      message: `run is ${run.state}; only terminated runs can be continued`,
    };
  }
  if (!run.claude_session_id) {
    return {
      ok: false,
      code: 'no_session',
      message: 'no claude session captured for this run',
    };
  }
  const dir = runMountDir(runsDir, run.id);
  let hasJsonl = false;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const walk = (root: string, ents: fs.Dirent[]): void => {
      for (const e of ents) {
        if (hasJsonl) return;
        const full = path.join(root, e.name);
        if (e.isDirectory()) {
          try { walk(full, fs.readdirSync(full, { withFileTypes: true })); } catch { /* noop */ }
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          hasJsonl = true;
        }
      }
    };
    walk(dir, entries);
  } catch {
    // dir missing entirely
  }
  if (!hasJsonl) {
    return {
      ok: false,
      code: 'session_files_missing',
      message: 'claude session files are no longer on disk',
    };
  }
  return { ok: true };
}
