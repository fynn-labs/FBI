import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { registerUsageWsRoute } from './wsUsage.js';
import type { UsageState, UsageWsMessage } from '../../shared/types.js';
import WebSocket from 'ws';

describe('/api/ws/usage', () => {
  it('sends current snapshot on connect and forwards broadcasts', async () => {
    const state: UsageState = {
      plan: 'max', observed_at: 1, last_error: null, last_error_at: null, buckets: [], pacing: {},
    };
    const subs = new Set<(m: UsageWsMessage) => void>();
    const bus = {
      snapshot: () => state,
      subscribe: (cb: (m: UsageWsMessage) => void) => { subs.add(cb); return () => subs.delete(cb); },
    };
    const app = Fastify();
    await app.register(fastifyWebsocket);
    registerUsageWsRoute(app, { bus });
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = addr.replace('http', 'ws') + '/api/ws/usage';
    const ws = new WebSocket(url);
    const msgs: UsageWsMessage[] = [];
    ws.on('message', (data) => msgs.push(JSON.parse(data.toString()) as UsageWsMessage));
    await new Promise<void>((res) => ws.once('open', () => res()));
    await new Promise<void>((res) => setTimeout(res, 50));
    expect(msgs.at(0)).toMatchObject({ type: 'snapshot' });
    for (const s of subs) s({ type: 'threshold_crossed', bucket_id: 'x', threshold: 90, reset_at: null });
    await new Promise<void>((res) => setTimeout(res, 50));
    expect(msgs.at(-1)).toMatchObject({ type: 'threshold_crossed' });
    ws.close();
    await app.close();
  });
});
