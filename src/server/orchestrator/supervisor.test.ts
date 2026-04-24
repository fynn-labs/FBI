import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Integration-style tests for supervisor.sh. The script is written to be run
// inside a container, so `/workspace`, `/fbi`, and `/tmp/*` are hardcoded
// paths; we rewrite those to sandbox paths and stub `claude`/`git` via PATH.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_SRC = path.join(HERE, 'supervisor.sh');

interface Sandbox {
  root: string;
  fbi: string;
  workspace: string;
  bin: string;
  tmpOut: string;
  script: string;
}

function makeSandbox(): Sandbox {
  // Prefix deliberately avoids the strings 'fbi' and 'workspace' so the
  // path rewrites below don't match the sandbox root path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-test-'));
  const fbi = path.join(root, 'sbx-fbi');
  const workspace = path.join(root, 'sbx-ws');
  const bin = path.join(root, 'bin');
  const tmpOut = path.join(root, 'tmpout');
  for (const d of [fbi, workspace, bin, tmpOut]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Stub claude — exits 0 by default.
  fs.writeFileSync(
    path.join(bin, 'claude'),
    '#!/bin/sh\nexit 0\n',
    { mode: 0o755 },
  );
  // Stub git — tolerates the commands supervisor runs and produces the
  // outputs it reads back. Records `checkout` calls to a log file.
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh
case "$1" in
  clone) exit 0 ;;
  checkout)
    shift
    # Emit the final branch argument (last non-flag token) to the log.
    branch=""
    for a in "$@"; do
      case "$a" in -*) ;; *) branch="$a" ;; esac
    done
    echo "$branch" >> "${tmpOut}/checkouts.log"
    # Treat a branch named 'does-not-exist' as a missing ref.
    if [ "$branch" = "does-not-exist" ]; then exit 1; fi
    exit 0
    ;;
  config) exit 0 ;;
  add) exit 0 ;;
  commit) exit 0 ;;
  remote) exit 0 ;;
  rev-parse)
    # --verify --quiet origin/claude/run-* → exit 1 (branch not yet on remote,
    # i.e. fresh run). All other rev-parse forms succeed.
    for arg in "$@"; do
      case "$arg" in
        origin/claude/run-*) exit 1 ;;
      esac
    done
    case "$2" in
      --abbrev-ref) echo "main" ;;
      HEAD) echo "deadbeef0000000000000000000000000000dead" ;;
      *) echo "deadbeef" ;;
    esac
    exit 0
    ;;
  push) exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );

  // Stub resume-restore.sh (deliberately omits the `fbi-` prefix so the
  // `/fbi\b` path rewrite below doesn't clobber it). A fresh run has no WIP
  // snapshot to restore, so the stub always succeeds (exit 0) as a no-op.
  const resumeStub = path.join(bin, 'resume-restore-stub.sh');
  fs.writeFileSync(
    resumeStub,
    `#!/bin/sh
exit 0
`,
    { mode: 0o755 },
  );

  // Stub snapshot.sh (deliberately omits the `fbi-` prefix). Called by the
  // snapshot daemon. Just succeeds.
  const snapshotStub = path.join(bin, 'snapshot-stub.sh');
  fs.writeFileSync(
    snapshotStub,
    `#!/bin/sh
exit 0
`,
    { mode: 0o755 },
  );

  // Stub the finalize-branch helper — supervisor.sh delegates the post-
  // claude commit+push+result.json write to it. We just write a minimal
  // result.json so the tests' existing assertions pass. Stub filename
  // deliberately omits the `fbi-` prefix so the `/fbi\b` path rewrite below
  // doesn't clobber it.
  const finalizeStub = path.join(bin, 'finalize-stub.sh');
  fs.writeFileSync(
    finalizeStub,
    `#!/bin/sh
printf '{"exit_code":%d,"push_exit":0,"head_sha":"deadbeef","branch":"main"}\\n' \
  "\${CLAUDE_EXIT:-0}" > "\${RESULT_PATH:-/tmp/result.json}"
exit 0
`,
    { mode: 0o755 },
  );

  // Rewrite hardcoded container paths to sandbox paths so we can run the
  // script without Docker. Order matters: the finalize-branch path contains
  // `/fbi-…` which would otherwise be mangled by the `/fbi\b` substitution,
  // since `\b` matches at the hyphen. Substitute the longer, more specific
  // paths first.
  const src = fs.readFileSync(SUPERVISOR_SRC, 'utf8');
  const patched = src
    .replace(/\/usr\/local\/bin\/fbi-resume-restore\.sh/g, resumeStub)
    .replace(/\/usr\/local\/bin\/fbi-wip-snapshot\.sh/g, snapshotStub)
    .replace(/\/usr\/local\/bin\/fbi-finalize-branch\.sh/g, finalizeStub)
    .replace(/\/tmp\/prompt\.txt\b/g, path.join(tmpOut, 'prompt.txt'))
    .replace(/\/tmp\/result\.json\b/g, path.join(tmpOut, 'result.json'))
    .replace(/\/workspace\b/g, workspace)
    .replace(/\/fbi\b/g, fbi);
  const script = path.join(root, 'supervisor.sh');
  fs.writeFileSync(script, patched, { mode: 0o755 });

  return { root, fbi, workspace, bin, tmpOut, script };
}

function run(sb: Sandbox, env: Record<string, string>) {
  return spawnSync('bash', [sb.script], {
    env: {
      PATH: `${sb.bin}:${process.env.PATH ?? ''}`,
      HOME: sb.root,
      RUN_ID: '7',
      REPO_URL: 'git@example:org/repo.git',
      DEFAULT_BRANCH: 'main',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@b',
      ...env,
    },
    encoding: 'utf8',
  });
}

describe('supervisor.sh', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('resume path (FBI_RESUME_SESSION_ID set) does not require /fbi/prompt.txt', () => {
    // No prompt.txt is injected — this is the exact state the orchestrator
    // leaves /fbi in when calling claude --resume.
    const res = run(sb, { FBI_RESUME_SESSION_ID: 'session-abc' });
    expect(res.stdout + res.stderr).not.toContain('prompt.txt not found');
    expect(res.status).toBe(0);
    // result.json should be written so the orchestrator can classify.
    const result = JSON.parse(fs.readFileSync(path.join(sb.tmpOut, 'result.json'), 'utf8'));
    expect(result.exit_code).toBe(0);
  });

  it('fresh path still errors cleanly when /fbi/prompt.txt is missing', () => {
    const res = run(sb, {});
    expect(res.stdout + res.stderr).toContain('prompt.txt not found');
    expect(res.status).toBe(12);
  });

  it('fresh path succeeds when /fbi/prompt.txt exists', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'do the thing');
    const res = run(sb, {});
    expect(res.status).toBe(0);
    // Composed prompt should contain the run prompt.
    const composed = fs.readFileSync(path.join(sb.tmpOut, 'prompt.txt'), 'utf8');
    expect(composed).toContain('do the thing');
  });

  it('checks out FBI_CHECKOUT_BRANCH when set, then creates claude/run-N', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_CHECKOUT_BRANCH: 'feature/x' });
    expect(res.status).toBe(0);
    const checkouts = fs.readFileSync(path.join(sb.tmpOut, 'checkouts.log'), 'utf8').trim().split('\n');
    // [0] base branch checkout, [1] agent branch (claude/run-7)
    expect(checkouts[0]).toBe('feature/x');
    expect(checkouts[1]).toBe('claude/run-7');
  });

  it('falls through to DEFAULT_BRANCH when the requested branch is missing on remote, then creates claude/run-N', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_CHECKOUT_BRANCH: 'does-not-exist' });
    expect(res.status).toBe(0);
    const checkouts = fs.readFileSync(path.join(sb.tmpOut, 'checkouts.log'), 'utf8').trim().split('\n');
    // [0] attempted branch, [1] fallback to DEFAULT_BRANCH, [2] agent branch
    expect(checkouts[0]).toBe('does-not-exist');
    expect(checkouts[1]).toBe('main');
    expect(checkouts[2]).toBe('claude/run-7');
  });

  it('checks out DEFAULT_BRANCH when FBI_CHECKOUT_BRANCH is unset, then creates claude/run-N', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, {});
    expect(res.status).toBe(0);
    const checkouts = fs.readFileSync(path.join(sb.tmpOut, 'checkouts.log'), 'utf8').trim().split('\n');
    // [0] DEFAULT_BRANCH, [1] agent branch (claude/run-7)
    expect(checkouts[0]).toBe('main');
    expect(checkouts[1]).toBe('claude/run-7');
  });
});
