import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const ALLOWED_OS = new Set(['darwin', 'linux']);
const ALLOWED_ARCH = new Set(['amd64', 'arm64']);

export interface CliDeps {
  cliDistDir: string;
  version?: string;
}

export function registerCliRoutes(app: FastifyInstance, deps: CliDeps): void {
  app.get('/api/cli/fbi-tunnel/:os/:arch', async (req, reply) => {
    const { os: osParam, arch: archParam } = req.params as { os: string; arch: string };
    if (!ALLOWED_OS.has(osParam) || !ALLOWED_ARCH.has(archParam)) {
      return reply.code(400).send({ error: 'unsupported os/arch' });
    }
    const filename = `fbi-tunnel-${osParam}-${archParam}`;
    const filePath = path.join(deps.cliDistDir, filename);
    try { fs.statSync(filePath); }
    catch {
      return reply.code(503).send({ error: 'fbi-tunnel binary not built; rerun npm run build' });
    }
    reply
      .type('application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'public, max-age=3600');
    if (deps.version) reply.header('X-FBI-CLI-Version', deps.version);
    return reply.send(fs.createReadStream(filePath));
  });
}
