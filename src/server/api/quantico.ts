import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// In dev (tsx): src/server/api/quantico.ts → ../../../cli/quantico/scenarios.json
// In built dist: dist/server/api/quantico.js → same relative path holds.
const SCENARIOS_JSON = path.resolve(HERE, '../../../cli/quantico/scenarios.json');

let cached: Set<string> | null = null;
export function loadScenarioNames(): Set<string> {
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(SCENARIOS_JSON, 'utf8')) as { scenarios: string[] };
  cached = new Set(raw.scenarios);
  return cached;
}

export function registerQuanticoRoutes(
  app: FastifyInstance,
  cfg: { quanticoEnabled: boolean },
): void {
  app.get('/api/quantico/scenarios', async (_req, reply) => {
    if (!cfg.quanticoEnabled) return reply.code(404).send({ error: 'not_found' });
    return { scenarios: Array.from(loadScenarioNames()) };
  });
}
