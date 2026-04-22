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

    // Fix 4: guard against NaN run ids.
    if (!Number.isFinite(runId)) {
      socket.close(4004, 'invalid run id');
      return;
    }

    const run = deps.runs.get(runId);
    if (!run) {
      socket.close(4004, 'run not found');
      return;
    }

    // Terminal runs keep the socket open after replay: a user clicking
    // Continue revives the run into the same row, the orchestrator publishes
    // new bytes/state into the registry, and the client must still be
    // subscribed to receive them. When the continued run ends for real,
    // the broadcaster's end() fires onEnd below, which closes the socket.

    // Fix 2: Subscribe first so no live bytes are missed while we replay.
    const bc = deps.streams.getOrCreate(runId);
    const buffered: Uint8Array[] = [];
    let live = false;
    const unsub = bc.subscribe(
      (chunk) => {
        if (!live) { buffered.push(chunk); return; }
        if (socket.readyState === socket.OPEN) {
          socket.send(chunk, (err) => { if (err) unsub(); });
        }
      },
      () => {
        try { socket.close(1000, 'ended'); } catch { /* noop */ }
      }
    );

    // Typed-event channel (usage + rate_limit) sent as JSON text frames,
    // multiplexed over the same socket as the binary TTY stream.
    // Subscribe BEFORE log replay so no typed events are missed during replay.
    const ev = deps.streams.getOrCreateEvents(runId);
    const unsubEvents = ev.subscribe((msg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    });

    // Replay log, then flush any buffered live chunks.
    const existing = LogStore.readAll(run.log_path);
    if (existing.length > 0) socket.send(existing);
    live = true;
    for (const chunk of buffered) {
      if (socket.readyState === socket.OPEN) {
        socket.send(chunk, (err) => { if (err) unsub(); });
      }
    }

    // Fix 3: If broadcaster already ended, close now.
    if (bc.isEnded()) {
      unsub();
      unsubEvents();
      if (socket.readyState === socket.OPEN) socket.close(1000, 'ended');
      return;
    }

    // Subscribe to state frames and forward them as JSON text
    const stateBc = deps.streams.getOrCreateState(runId);
    const unsubState = stateBc.subscribe((frame) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        // Text frame — try to parse as control JSON.
        try {
          const msg = JSON.parse(data.toString('utf8')) as ControlFrame;
          if (msg.type === 'resize') {
            void deps.orchestrator.resize(runId, msg.cols, msg.rows);
          }
          return; // Fix 5: all text control frames: do not forward to stdin
        } catch { /* not valid JSON — fall through to stdin */ }
      }
      deps.orchestrator.writeStdin(runId, data);
    });

    socket.on('close', () => { unsub(); unsubState(); unsubEvents(); });
  });

  app.get('/api/ws/states', { websocket: true }, (socket: WebSocket) => {
    const unsub = deps.streams.getGlobalStates().subscribe((frame) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    });
    socket.on('close', () => { unsub(); });
  });
}
