import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSessionId, runMountDir, runStateDir, runUploadsDir } from './sessionId.js';

function tempdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-sess-'));
}

describe('runMountDir', () => {
  it('returns <runsDir>/<id>/claude-projects', () => {
    expect(runMountDir('/var/lib/fbi/runs', 42))
      .toBe('/var/lib/fbi/runs/42/claude-projects');
  });
});

describe('runStateDir', () => {
  it('returns {runsDir}/{id}/state', () => {
    expect(runStateDir('/var/lib/fbi/runs', 7)).toBe('/var/lib/fbi/runs/7/state');
  });
});

describe('runUploadsDir', () => {
  it('returns <runsDir>/<runId>/uploads', () => {
    expect(runUploadsDir('/var/lib/am/runs', 42)).toBe('/var/lib/am/runs/42/uploads');
  });
});

describe('scanSessionId', () => {
  it('returns null when directory does not exist', () => {
    expect(scanSessionId(path.join(tempdir(), 'missing'))).toBeNull();
  });

  it('returns null when no JSONL files are present', () => {
    const dir = tempdir();
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'other.txt'), 'x');
    expect(scanSessionId(dir)).toBeNull();
  });

  it('returns the UUID from a single JSONL filename under a sub-directory', () => {
    const dir = tempdir();
    const sub = path.join(dir, '-home-agent-workspace');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, 'b3e7f0a0-1234-5678-9abc-def012345678.jsonl'),
      'line\n',
    );
    expect(scanSessionId(dir)).toBe('b3e7f0a0-1234-5678-9abc-def012345678');
  });

  it('returns the newest file when several exist', () => {
    const dir = tempdir();
    const sub = path.join(dir, '-workspace');
    fs.mkdirSync(sub, { recursive: true });
    const older = path.join(sub, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
    const newer = path.join(sub, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');
    fs.writeFileSync(older, 'x');
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.writeFileSync(newer, 'y');
    fs.utimesSync(newer, new Date(2000), new Date(2000));
    expect(scanSessionId(dir)).toBe('bbbbbbbb-1111-2222-3333-444444444444');
  });

  it('rejects non-UUID .jsonl filenames', () => {
    const dir = tempdir();
    const sub = path.join(dir, '-workspace');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'not-a-uuid.jsonl'), 'x');
    expect(scanSessionId(dir)).toBeNull();
  });
});
