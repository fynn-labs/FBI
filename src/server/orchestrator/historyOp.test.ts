import { describe, it, expect } from 'vitest';
import { parseHistoryOpResult, runHistoryOpInTransientContainer } from './historyOp.js';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

describe('parseHistoryOpResult', () => {
  it('parses successful completion', () => {
    const r = parseHistoryOpResult('{"ok":true,"sha":"deadbeef","message":""}\n', 0);
    expect(r).toEqual({ kind: 'complete', sha: 'deadbeef' });
  });
  it('parses conflict', () => {
    const r = parseHistoryOpResult('{"ok":false,"reason":"conflict","message":"merge conflict"}\n', 0);
    expect(r).toEqual({ kind: 'conflict-detected', message: 'merge conflict' });
  });
  it('parses gh-error', () => {
    const r = parseHistoryOpResult('{"ok":false,"reason":"gh-error","message":"push failed"}\n', 0);
    expect(r).toEqual({ kind: 'gh-error', message: 'push failed' });
  });
  it('treats non-zero exit as gh-error when no JSON', () => {
    const r = parseHistoryOpResult('', 2);
    expect(r).toEqual({ kind: 'gh-error', message: 'exit code 2' });
  });
  it('handles multi-line output by taking the last JSON line', () => {
    const r = parseHistoryOpResult('progress…\n{"ok":true,"sha":"abc"}\n', 0);
    expect(r).toEqual({ kind: 'complete', sha: 'abc' });
  });
});

function frame(type: 1 | 2, payload: Buffer): Buffer {
  const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

describe('runHistoryOpInTransientContainer', () => {
  it('creates, runs, parses output, and removes the container', async () => {
    const logsStream = new PassThrough();
    setTimeout(() => {
      logsStream.write(frame(1, Buffer.from('{"ok":true,"sha":"cafebabe"}\n')));
      logsStream.end();
    }, 5);
    const container = {
      id: 'x',
      start: vi.fn().mockResolvedValue(undefined),
      logs: vi.fn().mockResolvedValue(logsStream),
      wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
      remove: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
    };
    const docker = { createContainer: vi.fn().mockResolvedValue(container) };

    const r = await runHistoryOpInTransientContainer({
      docker: docker as never,
      image: 'alpine/git:latest',
      repoUrl: 'git@github.com:me/foo.git',
      historyOpScriptPath: '/host/path/fbi-history-op.sh',
      env: { FBI_OP: 'sync', FBI_BRANCH: 'feat/x', FBI_DEFAULT: 'main', FBI_RUN_ID: '1' },
      sshSocket: '/tmp/sock',
      authorName: 'a', authorEmail: 'a@b', timeoutMs: 10_000,
    });

    expect(r).toEqual({ kind: 'complete', sha: 'cafebabe' });
    expect(container.remove).toHaveBeenCalled();
  });
});
