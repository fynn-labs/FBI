import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { RunsRepo } from '../db/runs.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { LogStore } from '../logs/store.js';

interface Orchestrator {
  writeStdin(runId: number, bytes: Uint8Array): void;
  resize(runId: number, cols: number, rows: number): Promise<void>;
  cancel(runId: number): Promise<void>;
}

interface Deps {
  runs: RunsRepo;
  streams: RunStreamRegistry;
  orchestrator: Orchestrator;
}

interface ControlFrame {
  type: 'resize';
  cols: number;
  rows: number;
}

export function registerWsRoute(app: FastifyInstance, deps: Deps): void {
  app.get('/api/runs/:id/shell', { websocket: true }, (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) {
      socket.close(4004, 'run not found');
      return;
    }

    // Replay existing log bytes.
    const existing = LogStore.readAll(run.log_path);

    // If run is finished, replay and then close.
    if (run.state !== 'running' && run.state !== 'queued') {
      if (existing.length > 0) {
        socket.send(existing, () => {
          socket.close(1000, 'ended');
        });
      } else {
        socket.close(1000, 'ended');
      }
      return;
    }

    if (existing.length > 0) socket.send(existing);

    // Subscribe to live broadcaster.
    const bc = deps.streams.getOrCreate(runId);
    const unsub = bc.subscribe(
      (chunk) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk);
      },
      () => {
        try { socket.close(1000, 'ended'); } catch { /* noop */ }
      }
    );

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        // Text frame — try to parse as control JSON.
        try {
          const msg = JSON.parse(data.toString('utf8')) as ControlFrame;
          if (msg.type === 'resize') {
            void deps.orchestrator.resize(runId, msg.cols, msg.rows);
            return;
          }
        } catch { /* fall through to stdin */ }
      }
      deps.orchestrator.writeStdin(runId, data);
    });

    socket.on('close', () => unsub());
  });
}
