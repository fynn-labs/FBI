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

    // Build + send the initial snapshot. If no ScreenState exists yet
    // (e.g. fresh process, run is still spinning up and the orchestrator
    // hasn't wired the byte pipeline), lazily rebuild from the log file —
    // this also covers the "server was restarted mid-run" case.
    const sendSnapshot = async (): Promise<void> => {
      let screen = deps.streams.getScreen(runId);
      if (!screen) {
        screen = await deps.streams.rebuildScreenFromLog(runId, run.log_path);
      }
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({
        type: 'snapshot',
        // Cell contents first (SerializeAddon), then tracked modes at
        // *current* dims. Modes-last means DECSTBM etc. are correct for
        // the live bytes that follow; content doesn't depend on modes.
        ansi: screen.serialize() + screen.modesAnsi(),
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
        // Edge: broadcaster ended while we were building the snapshot.
        if (bc.isEnded()) {
          unsub();
          unsubEvents();
          unsubState();
          if (socket.readyState === socket.OPEN) socket.close(1000, 'ended');
        }
      })
      .catch(() => {
        // rebuildScreenFromLog failed (I/O error). Tear down so the client
        // doesn't hang; they'll reconnect and try again.
        unsub();
        unsubEvents();
        unsubState();
        if (socket.readyState === socket.OPEN) socket.close(1011, 'snapshot error');
      });

    socket.on('message', async (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString('utf8')) as ControlFrame;
          if (msg.type === 'resize') {
            // Resize the PTY (sends SIGWINCH to the TUI) and the
            // ScreenState. xterm's reflow on resize is best-effort and
            // doesn't perfectly fix wrapping baked in at the old dims —
            // the TUI (Claude Code) responds to SIGWINCH by emitting a
            // fresh full-screen redraw at the new dims; once those bytes
            // are parsed, the ScreenState reflects the correct layout.
            //
            // We deliberately do NOT suspend live forwarding during the
            // wait below: keystroke echoes and other live updates need to
            // keep flowing so input feels responsive. Brief visual
            // overlap during the 200 ms is acceptable; the snapshot then
            // clears and replaces.
            const screenBefore = deps.streams.getScreen(runId);
            const dimsChanged =
              !screenBefore ||
              screenBefore.cols !== msg.cols ||
              screenBefore.rows !== msg.rows;
            await deps.orchestrator.resize(runId, msg.cols, msg.rows);
            if (dimsChanged) {
              // Wait for the redraw to land before serializing. Without
              // this wait, the snapshot captures pre-redraw content
              // (still wrapped at old dims) and the client renders it
              // mis-wrapped. Skip the wait for no-op resizes so refocus/
              // idle resizes don't add visible latency.
              await new Promise((r) => setTimeout(r, 200));
            }
            const screen = deps.streams.getScreen(runId);
            if (screen && socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                type: 'snapshot',
                ansi: screen.serialize() + screen.modesAnsi(),
                cols: screen.cols,
                rows: screen.rows,
              }));
            }
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
                ansi: screen.serialize() + screen.modesAnsi(),
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
