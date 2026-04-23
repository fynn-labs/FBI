import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { snapshotScripts } from './snapshotScripts.js';

function tempdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-snap-'));
}

describe('snapshotScripts', () => {
  let root: string;
  beforeEach(() => { root = tempdir(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('copies both scripts with executable permission', () => {
    const srcSup = path.join(root, 'src-sup.sh');
    const srcFin = path.join(root, 'src-fin.sh');
    fs.writeFileSync(srcSup, '#!/bin/sh\necho sup\n', { mode: 0o644 });
    fs.writeFileSync(srcFin, '#!/bin/sh\necho fin\n', { mode: 0o644 });
    const dest = path.join(root, 'dest');

    snapshotScripts(dest, srcSup, srcFin);

    expect(fs.readFileSync(path.join(dest, 'supervisor.sh'), 'utf8')).toBe('#!/bin/sh\necho sup\n');
    expect(fs.readFileSync(path.join(dest, 'finalizeBranch.sh'), 'utf8')).toBe('#!/bin/sh\necho fin\n');
    // Executable bits — the container runs the supervisor as entrypoint.
    expect(fs.statSync(path.join(dest, 'supervisor.sh')).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(dest, 'finalizeBranch.sh')).mode & 0o111).not.toBe(0);
  });

  it('produces an independent copy — later source edits do not reach the snapshot', () => {
    const srcSup = path.join(root, 'sup.sh');
    const srcFin = path.join(root, 'fin.sh');
    fs.writeFileSync(srcSup, 'ORIGINAL_SUP\n');
    fs.writeFileSync(srcFin, 'ORIGINAL_FIN\n');
    const dest = path.join(root, 'dest');

    snapshotScripts(dest, srcSup, srcFin);
    // Rewrite the sources post-snapshot. The fix's whole point: the snapshot
    // must not reflect edits made after container-create.
    fs.writeFileSync(srcSup, 'MUTATED_SUP\n');
    fs.writeFileSync(srcFin, 'MUTATED_FIN\n');

    expect(fs.readFileSync(path.join(dest, 'supervisor.sh'), 'utf8')).toBe('ORIGINAL_SUP\n');
    expect(fs.readFileSync(path.join(dest, 'finalizeBranch.sh'), 'utf8')).toBe('ORIGINAL_FIN\n');
  });

  it('creates destDir when it does not yet exist', () => {
    const srcSup = path.join(root, 'sup.sh');
    const srcFin = path.join(root, 'fin.sh');
    fs.writeFileSync(srcSup, 'a');
    fs.writeFileSync(srcFin, 'b');
    const nested = path.join(root, 'a', 'b', 'c');

    snapshotScripts(nested, srcSup, srcFin);

    expect(fs.existsSync(path.join(nested, 'supervisor.sh'))).toBe(true);
    expect(fs.existsSync(path.join(nested, 'finalizeBranch.sh'))).toBe(true);
  });
});

// End-to-end regression: this recreates the user-reported failure mode
// (bash reading a mutated-mid-run script by stale byte offset) and asserts
// that the snapshot path is immune to it.
describe('snapshotScripts regression: bash mid-run file mutation', () => {
  let root: string;
  beforeEach(() => { root = tempdir(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // A short script with a wait+else arm. The else arm contains the exact
  // `for section in preamble.txt global.txt instructions.txt; do` line from
  // supervisor.sh — bash landing mid-line there is what produces the user's
  // error text.
  const V1 = `#!/usr/bin/env bash
set -euo pipefail
echo START
if [ "1" = "1" ]; then
    sleep 2
    EXIT=$?
else
    for section in preamble.txt global.txt instructions.txt; do
        :
    done
    EXIT=$?
fi
echo END
`;
  // Same content with 10 lines of padding at the top. Swapping V1 -> V2
  // while bash is sleeping mimics a host-side edit shifting the file by ~10
  // lines, which is exactly what commit b3b11e1 did to supervisor.sh.
  const V2 = `#!/usr/bin/env bash
# pad 1
# pad 2
# pad 3
# pad 4
# pad 5
# pad 6
# pad 7
# pad 8
# pad 9
# pad 10
set -euo pipefail
echo START
if [ "1" = "1" ]; then
    sleep 2
    EXIT=$?
else
    for section in preamble.txt global.txt instructions.txt; do
        :
    done
    EXIT=$?
fi
echo END
`;

  // Run `bash <scriptPath>`, mutate `scriptPath` partway through, collect
  // stderr. Resolves with the stderr string once bash exits.
  function runAndMutate(scriptPath: string, newContent: string): Promise<{ stderr: string; code: number | null }> {
    fs.chmodSync(scriptPath, 0o755);
    return new Promise((resolve) => {
      const child = spawn('bash', [scriptPath]);
      let stderr = '';
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
      child.stdout.on('data', () => {});
      setTimeout(() => { fs.writeFileSync(scriptPath, newContent); }, 500);
      child.on('exit', (code) => resolve({ stderr, code }));
    });
  }

  it('mutating the source script mid-run (no snapshot) reproduces a bash syntax error', async () => {
    // Control: prove the mechanism is real. If this ever starts passing
    // cleanly, the bug has moved and the fix's premise needs re-examination.
    const live = path.join(root, 'live.sh');
    fs.writeFileSync(live, V1);
    const { stderr, code } = await runAndMutate(live, V2);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/syntax error|unexpected/i);
  });

  it('snapshot is immune — mutating the source after snapshotScripts leaves the bind target intact', async () => {
    const srcSup = path.join(root, 'source-supervisor.sh');
    const srcFin = path.join(root, 'source-finalize.sh');
    fs.writeFileSync(srcSup, V1);
    fs.writeFileSync(srcFin, '#!/bin/sh\nexit 0\n');
    const dest = path.join(root, 'snapshot');
    snapshotScripts(dest, srcSup, srcFin);
    const pinned = path.join(dest, 'supervisor.sh');

    // Bash runs the *snapshot* file; meanwhile we mutate only the *source*.
    // Nothing touches the snapshot, so execution must complete cleanly.
    const run = await new Promise<{ stderr: string; code: number | null }>((resolve) => {
      const child = spawn('bash', [pinned]);
      let err = '';
      child.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });
      child.stdout.on('data', () => {});
      setTimeout(() => { fs.writeFileSync(srcSup, V2); }, 500);
      child.on('exit', (c) => resolve({ stderr: err, code: c }));
    });

    expect(run.code).toBe(0);
    expect(run.stderr).not.toMatch(/syntax error/i);
  });
});
