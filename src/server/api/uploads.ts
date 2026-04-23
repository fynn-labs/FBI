import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import type { RunsRepo } from '../db/runs.js';
import type { LogStore } from '../logs/store.js';
import { generateDraftToken, isDraftToken } from '../uploads/token.js';
import { sanitizeFilename, resolveFilename, directoryBytes } from '../uploads/filenames.js';

const PER_RUN_BYTES = 1024 * 1024 * 1024;

interface Deps {
  runs: RunsRepo;
  runsDir: string;
  draftUploadsDir: string;
  logs: LogStore;
}

export function registerUploadsRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/api/draft-uploads', async (req, reply) => {
    const query = req.query as { draft_token?: unknown };
    let token = typeof query.draft_token === 'string' ? query.draft_token : '';
    if (token.length > 0 && !isDraftToken(token)) {
      return reply.code(400).send({ error: 'invalid_token' });
    }
    if (token.length === 0) token = generateDraftToken();

    const dir = path.join(deps.draftUploadsDir, token);
    await fsp.mkdir(dir, { recursive: true });

    const result = await consumeOneFile(req, dir, PER_RUN_BYTES);
    if ('error' in result) return reply.code(result.status).send({ error: result.error });

    return reply.code(200).send({
      draft_token: token,
      filename: result.filename,
      size: result.size,
      uploaded_at: result.uploadedAt,
    });
  });

  app.delete('/api/draft-uploads/:token/:filename', async (req, reply) => {
    const params = req.params as { token: string; filename: string };
    if (!isDraftToken(params.token)) {
      return reply.code(400).send({ error: 'invalid_token' });
    }
    let filename: string;
    try {
      filename = sanitizeFilename(params.filename);
    } catch {
      return reply.code(400).send({ error: 'invalid_filename' });
    }
    const dir = path.join(deps.draftUploadsDir, params.token);
    const file = path.join(dir, filename);
    try {
      await fsp.unlink(file);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.code(204).send();
  });
}

interface ConsumeOk {
  filename: string;
  size: number;
  uploadedAt: number;
}
interface ConsumeErr {
  error: string;
  status: number;
}

async function consumeOneFile(
  req: Parameters<Parameters<FastifyInstance['post']>[1]>[0],
  targetDir: string,
  cumulativeLimit: number,
): Promise<ConsumeOk | ConsumeErr> {
  const mp: MultipartFile | undefined = await req.file();
  if (!mp) return { error: 'no_file', status: 400 };

  let sanitized: string;
  try {
    sanitized = sanitizeFilename(mp.filename);
  } catch {
    mp.file.resume();
    return { error: 'invalid_filename', status: 400 };
  }

  const existing = await directoryBytes(targetDir);
  if (existing >= cumulativeLimit) {
    mp.file.resume();
    return { error: 'run_quota_exceeded', status: 413 };
  }

  const finalName = resolveFilename(targetDir, sanitized);
  const finalPath = path.join(targetDir, finalName);
  const partPath = finalPath + '.part';

  const out = fs.createWriteStream(partPath, { flags: 'w' });
  let written = 0;
  let overflow = false;
  mp.file.on('data', (chunk: Buffer) => {
    written += chunk.length;
    if (existing + written > cumulativeLimit) {
      overflow = true;
      mp.file.destroy();
    }
  });
  try {
    await pipeline(mp.file, out);
  } catch {
    await fsp.unlink(partPath).catch(() => {});
    if (overflow) return { error: 'run_quota_exceeded', status: 413 };
    if (mp.file.truncated) {
      return { error: 'file_too_large', status: 413 };
    }
    return { error: 'io_error', status: 500 };
  }
  if (overflow) {
    await fsp.unlink(partPath).catch(() => {});
    return { error: 'run_quota_exceeded', status: 413 };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fsp.link(partPath, finalPath);
      await fsp.unlink(partPath);
      return { filename: finalName, size: written, uploadedAt: Date.now() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fsp.unlink(partPath).catch(() => {});
        return { error: 'io_error', status: 500 };
      }
      const retryName = resolveFilename(targetDir, sanitized);
      const retryPath = path.join(targetDir, retryName);
      try {
        await fsp.link(partPath, retryPath);
        await fsp.unlink(partPath);
        return { filename: retryName, size: written, uploadedAt: Date.now() };
      } catch {
        /* will retry outer loop */
      }
    }
  }
  await fsp.unlink(partPath).catch(() => {});
  return { error: 'io_error', status: 500 };
}
