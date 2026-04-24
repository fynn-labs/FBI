import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { RunsRepo } from '../db/runs.js';
import type { RunStreamRegistry } from '../logs/registry.js';

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

type ControlFrame =
  | { type: 'hello'; cols: number; rows: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'resync' };

export function registerWsRoute(app: FastifyInstance, deps: Deps): void {
  app.get('/api/runs/:id/shell', { websocket: true }, (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);

    if (!Number.isFinite(runId)) {
      socket.close(4004, 'invalid run id');
      return;
    }

    const run = deps.runs.get(runId);
    if (!run) {
      socket.close(4004, 'run not found');
      return;
    }

    // Every run — live, awaiting_resume, or finished — gets the snapshot
    // path. Finished runs may be revived via Continue, which reuses this
    // socket; the snapshot reflects whatever's currently on screen, and the
    // broadcaster's end() (onEnd below) closes the socket when the run truly
    // ends.
    //
    // Subscribe to the bytes broadcaster BEFORE sending the snapshot so no
    // live bytes are missed during the snapshot build/send window; buffer
    // any that arrive in the window and flush immediately after.
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

    const ev = deps.streams.getOrCreateEvents(runId);
    const unsubEvents = ev.subscribe((msg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    });

    const stateBc = deps.streams.getOrCreateState(runId);
    const unsubState = stateBc.subscribe((frame) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    });

    // Resolves on hello receipt with the client's dims, or null on 1500 ms timeout.
    type HelloDims = { cols: number; rows: number } | null;
    let helloResolve: (dims: HelloDims) => void = () => {};
    const helloPromise = new Promise<HelloDims>((r) => { helloResolve = r; });
    const helloTimeout = setTimeout(() => helloResolve(null), 1500);

    const sendSnapshot = async (): Promise<void> => {
      const hello = await helloPromise;
      clearTimeout(helloTimeout);
      if (socket.readyState !== socket.OPEN) return;

      let screen = deps.streams.getScreen(runId);
      if (!screen) {
        screen = await deps.streams.rebuildScreenFromLog(runId, run.log_path);
      }

      if (hello) {
        // Apply hello dims to the PTY (SIGWINCH) and ScreenState before
        // serializing. Orchestrator may reject (e.g., no active container
        // yet) — tolerate and continue; TUI will repaint on next redraw.
        await deps.orchestrator.resize(runId, hello.cols, hello.rows).catch(() => {});
        screen.resize(hello.cols, hello.rows);
      }

      // Flush any previously-queued bytes through the headless parser
      // before serializing. Prevents catching a chunk mid-parse, which
      // is the cursor-disappear root cause.
      await screen.drain();
      if (socket.readyState !== socket.OPEN) return;

      socket.send(JSON.stringify({
        type: 'snapshot',
        // modesAnsi FIRST, then cell contents. See ws.ts comment below
        // that this replaces for rationale.
        ansi: screen.modesAnsi() + screen.serialize(),
        cols: screen.cols,
        rows: screen.rows,
      }));
    };

    void sendSnapshot()
      .then(() => {
        live = true;
        for (const chunk of buffered) {
          if (socket.readyState === socket.OPEN) {
            socket.send(chunk, (err) => { if (err) unsub(); });
          }
        }
        buffered.length = 0;
        if (bc.isEnded()) {
          unsub();
          unsubEvents();
          unsubState();
          if (socket.readyState === socket.OPEN) socket.close(1000, 'ended');
        }
      })
      .catch(() => {
        unsub();
        unsubEvents();
        unsubState();
        if (socket.readyState === socket.OPEN) socket.close(1011, 'snapshot error');
      });

    socket.on('message', async (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString('utf8')) as ControlFrame;
          if (msg.type === 'hello') {
            // The first hello resolves pendingHello — that drives the
            // opening snapshot. Subsequent hellos (e.g. a cached-socket
            // remount) trigger a fresh snapshot via the same path.
            helloResolve({ cols: msg.cols, rows: msg.rows });
            // Re-arm the promise so a later remount can trigger another
            // snapshot. We only want this on subsequent hellos, not the
            // first — the first already kicked off sendSnapshot().
            //
            // Detecting "subsequent" cheaply: if `live` is already true,
            // the first snapshot has been sent, so this is a re-hello.
            if (live) {
              live = false;
              // Start buffering bytes again during the new serialize window.
              const reHello: HelloDims = { cols: msg.cols, rows: msg.rows };
              let screen = deps.streams.getScreen(runId);
              if (!screen) {
                screen = await deps.streams.rebuildScreenFromLog(runId, run.log_path);
              }
              await deps.orchestrator.resize(runId, reHello.cols, reHello.rows).catch(() => {});
              screen.resize(reHello.cols, reHello.rows);
              await screen.drain();
              if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({
                  type: 'snapshot',
                  ansi: screen.modesAnsi() + screen.serialize(),
                  cols: screen.cols,
                  rows: screen.rows,
                }));
              }
              live = true;
              for (const chunk of buffered) {
                if (socket.readyState === socket.OPEN) {
                  socket.send(chunk, (err) => { if (err) unsub(); });
                }
              }
              buffered.length = 0;
            }
            return;
          }
          if (msg.type === 'resize') {
            await deps.orchestrator.resize(runId, msg.cols, msg.rows).catch(() => {});
            deps.streams.getScreen(runId)?.resize(msg.cols, msg.rows);
            // No snapshot re-send. Claude's SIGWINCH response flows
            // through the live byte stream naturally.
            return;
          }
          if (msg.type === 'resync') {
            // Re-serialize the current screen. If none exists in memory (rare —
            // e.g. a previous rebuild failed), try a fresh rebuild from log.
            let screen = deps.streams.getScreen(runId);
            if (!screen) {
              try {
                screen = await deps.streams.rebuildScreenFromLog(runId, run.log_path);
              } catch { /* swallow; leave screen undefined */ }
            }
            if (screen && socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                type: 'snapshot',
                ansi: screen.modesAnsi() + screen.serialize(),
                cols: screen.cols,
                rows: screen.rows,
              }));
            }
            return;
          }
          return; // any other text frame: ignore, do not forward to stdin
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
