import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerQuanticoRoutes, loadScenarioNames } from './quantico.js';

describe('GET /api/quantico/scenarios', () => {
  it('404s when capability flag is off', async () => {
    const app = Fastify();
    registerQuanticoRoutes(app, { quanticoEnabled: false });
    const res = await app.inject({ method: 'GET', url: '/api/quantico/scenarios' });
    expect(res.statusCode).toBe(404);
  });

  it('returns the scenario list when on', async () => {
    const app = Fastify();
    registerQuanticoRoutes(app, { quanticoEnabled: true });
    const res = await app.inject({ method: 'GET', url: '/api/quantico/scenarios' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scenarios: string[] };
    expect(body.scenarios).toContain('default');
    expect(body.scenarios).toContain('limit-breach');
  });

  it('loadScenarioNames reads from cli/quantico/scenarios.json', () => {
    const names = loadScenarioNames();
    expect(names.has('default')).toBe(true);
    expect(names.size).toBeGreaterThanOrEqual(12);
  });
});
