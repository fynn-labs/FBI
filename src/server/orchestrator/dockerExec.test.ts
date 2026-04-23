import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { dockerExec } from './dockerExec.js';

function frame(type: 1 | 2, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

interface FakeOpts {
  stdout?: Buffer;
  stderr?: Buffer;
  exitCode?: number;
  hang?: boolean;
}

function makeFakeContainer(opts: FakeOpts) {
  const stream = new PassThrough();
  if (!opts.hang) {
    setTimeout(() => {
      if (opts.stdout && opts.stdout.length > 0) stream.write(frame(1, opts.stdout));
      if (opts.stderr && opts.stderr.length > 0) stream.write(frame(2, opts.stderr));
      stream.end();
    }, 5);
  }
  return {
    exec: vi.fn().mockResolvedValue({
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: opts.exitCode ?? 0 }),
    }),
  };
}

describe('dockerExec', () => {
  it('returns stdout and exit code on success', async () => {
    const c = makeFakeContainer({ stdout: Buffer.from('hello\n'), exitCode: 0 });
    const r = await dockerExec(c as never, ['echo', 'hi']);
    expect(r.stdout).toBe('hello\n');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
  });

  it('captures stderr and non-zero exit code', async () => {
    const c = makeFakeContainer({ stderr: Buffer.from('nope\n'), exitCode: 2 });
    const r = await dockerExec(c as never, ['false']);
    expect(r.stderr).toBe('nope\n');
    expect(r.exitCode).toBe(2);
  });

  it('rejects with timeout message', async () => {
    const c = makeFakeContainer({ hang: true });
    await expect(dockerExec(c as never, ['sleep', '30'], { timeoutMs: 20 })).rejects.toThrow(/timeout/);
  });

  it('demuxes interleaved stdout+stderr frames', async () => {
    const c = makeFakeContainer({
      stdout: Buffer.from('out\n'),
      stderr: Buffer.from('err\n'),
      exitCode: 0,
    });
    const r = await dockerExec(c as never, ['sh', '-c', 'x']);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
  });
});
