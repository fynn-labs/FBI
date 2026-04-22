import Fastify from 'fastify';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const app = Fastify({ logger: true });

  app.get('/api/health', async () => ({ ok: true }));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
