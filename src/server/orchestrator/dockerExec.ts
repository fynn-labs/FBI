import type Docker from 'dockerode';

export interface DockerExecOptions {
  timeoutMs?: number;
  workingDir?: string;
  env?: string[];
}

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function dockerExec(
  container: Docker.Container,
  cmd: string[],
  opts: DockerExecOptions = {},
): Promise<DockerExecResult> {
  const { timeoutMs = 5000, workingDir } = opts;
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    ...(workingDir ? { WorkingDir: workingDir } : {}),
    ...(opts.env ? { Env: opts.env } : {}),
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  return await new Promise<DockerExecResult>((resolve, reject) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { (stream as unknown as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
      reject(new Error(`dockerExec timeout after ${timeoutMs}ms: ${cmd.join(' ')}`));
    }, timeoutMs);

    demux(
      stream as unknown as NodeJS.ReadableStream,
      (kind, chunk) => {
        (kind === 2 ? errChunks : outChunks).push(chunk);
      },
      async () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          const info = await exec.inspect();
          resolve({
            stdout: Buffer.concat(outChunks).toString('utf8'),
            stderr: Buffer.concat(errChunks).toString('utf8'),
            exitCode: typeof info.ExitCode === 'number' ? info.ExitCode : -1,
          });
        } catch (e) {
          reject(e);
        }
      },
      (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Docker multiplexes stdout/stderr over one stream with an 8-byte header per
// frame: [type, 0, 0, 0, size32BE]. type=1 stdout, type=2 stderr.
function demux(
  stream: NodeJS.ReadableStream,
  onChunk: (kind: 1 | 2, payload: Buffer) => void,
  onEnd: () => void,
  onError: (e: Error) => void,
): void {
  let buf: Buffer = Buffer.alloc(0);
  stream.on('data', (d: Buffer) => {
    buf = buf.length === 0 ? Buffer.from(d) : Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const kind = buf[0] as 1 | 2;
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      const payload = Buffer.from(buf.subarray(8, 8 + size));
      onChunk(kind, payload);
      buf = Buffer.from(buf.subarray(8 + size));
    }
  });
  stream.on('end', onEnd);
  stream.on('error', onError);
}
