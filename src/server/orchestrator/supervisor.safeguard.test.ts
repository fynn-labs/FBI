import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_SRC = path.join(HERE, 'supervisor.sh');

interface Sandbox { root: string; fbi: string; fbiState: string; ws: string; safe: string; bin: string; tmp: string; script: string; gitLog: string }

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgsup-'));
  const fbi = path.join(root, 'sbx-fbi');
  const fbiState = path.join(root, 'sbx-fbi-state');
  const ws = path.join(root, 'sbx-ws');
  const safe = path.join(root, 'sbx-safe');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmpout');
  const gitLog = path.join(tmp, 'git.log');
  for (const d of [fbi, fbiState, ws, safe, bin, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Git stub: log every invocation, succeed for everything except look up of
  // `safeguard/<branch>` (simulate fresh: the branch does not yet exist on safeguard).
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
echo "$@" >> "${gitLog}"
case "$1" in
  rev-parse)
    if [ -n "\${FBI_SAFEGUARD_HAS_BRANCH:-}" ]; then
      for a in "$@"; do case "$a" in safeguard/*) exit 0 ;; esac; done
    fi
    for a in "$@"; do case "$a" in origin/*|safeguard/*) exit 1 ;; esac; done
    echo deadbeef; exit 0 ;;
  remote)
    [ "$2" = "get-url" ] && [ "$3" = "origin" ] && { echo git@example:x/y.git; exit 0; }
    exit 0 ;;
  clone|checkout|add|commit|push|config|fetch|init|symbolic-ref) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const finalizeStub = path.join(bin, 'finalize-stub.sh');
  fs.writeFileSync(finalizeStub, `#!/bin/sh
printf '{"exit_code":%d,"push_exit":0,"head_sha":"x","branch":"b"}\\n' "\${CLAUDE_EXIT:-0}" > "\${RESULT_PATH:-/tmp/result.json}"
exit 0
`, { mode: 0o755 });
  const src = fs.readFileSync(SUPERVISOR_SRC, 'utf8');
  const patched = src
    .replace(/\/usr\/local\/bin\/fbi-finalize-branch\.sh/g, finalizeStub)
    .replace(/\/tmp\/prompt\.txt\b/g, path.join(tmp, 'prompt.txt'))
    .replace(/\/tmp\/result\.json\b/g, path.join(tmp, 'result.json'))
    .replace(/\/safeguard\b/g, safe)
    .replace(/\/workspace\b/g, ws)
    .replace(/\/fbi-state\b/g, fbiState)
    .replace(/\/fbi\b/g, fbi);
  const script = path.join(root, 'supervisor.sh');
  fs.writeFileSync(script, patched, { mode: 0o755 });
  return { root, fbi, fbiState, ws, safe, bin, tmp, script, gitLog };
}

function run(sb: Sandbox, env: Record<string, string>) {
  return spawnSync('bash', [sb.script], {
    env: { PATH: `${sb.bin}:${process.env.PATH ?? ''}`, HOME: sb.root,
      RUN_ID: '3', REPO_URL: 'git@example:x/y.git', DEFAULT_BRANCH: 'main',
      GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', ...env },
    encoding: 'utf8',
  });
}

describe('supervisor.sh (safeguard model)', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => { try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* noop */ } });

  it('registers a safeguard remote pointing at /safeguard', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_BRANCH: 'feat/x' });
    expect(res.status).toBe(0);
    const log = fs.readFileSync(sb.gitLog, 'utf8');
    expect(log).toMatch(new RegExp(`remote add safeguard ${sb.safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('does NOT push claude/run-<id> to origin when FBI_BRANCH is set to a user branch', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_BRANCH: 'feat/x' });
    expect(res.status).toBe(0);
    const log = fs.readFileSync(sb.gitLog, 'utf8');
    expect(log).not.toMatch(/push .*origin .*claude\/run-3/);
  });

  it('installs a post-commit hook that pushes to safeguard and origin', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_BRANCH: 'feat/x' });
    expect(res.status).toBe(0);
    const hook = fs.readFileSync(path.join(sb.ws, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).toContain('push safeguard');
    expect(hook).toContain('force-with-lease');
    expect(hook).toContain('origin');
  });

  it('resume path fetches branch from safeguard and checkouts -B', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    // Simulate that safeguard has the branch via FBI_SAFEGUARD_HAS_BRANCH.
    const res = run(sb, { FBI_BRANCH: 'feat/x', FBI_RESUME_SESSION_ID: 'sess-1', FBI_SAFEGUARD_HAS_BRANCH: '1' });
    expect(res.status).toBe(0);
    const log = fs.readFileSync(sb.gitLog, 'utf8');
    expect(log).toMatch(/fetch .*safeguard feat\/x/);
    expect(log).toMatch(/checkout -B feat\/x safeguard\/feat\/x/);
  });
});
