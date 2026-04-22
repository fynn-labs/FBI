import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { UsageState, UsageWsMessage } from '../../shared/types.js';

export interface UsageWsBus {
  snapshot: () => UsageState;
  subscribe: (cb: (m: UsageWsMessage) => void) => () => void;
}

export function registerUsageWsRoute(app: FastifyInstance, deps: { bus: UsageWsBus }): void {
  app.get('/api/ws/usage', { websocket: true }, (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: 'snapshot', state: deps.bus.snapshot() } as UsageWsMessage));
    const unsub = deps.bus.subscribe((m) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    });
    socket.on('close', () => unsub());
  });
}
