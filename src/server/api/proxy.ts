import fs from 'node:fs';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { RunsRepo } from '../db/runs.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { parseProcNetTcp } from '../proxy/procListeners.js';

export interface ProxyOrchestrator {
  getLiveContainer(runId: number): {
    inspect: () => Promise<{
      State: { Pid: number };
      NetworkSettings: {
        IPAddress: string;
        Networks?: Record<string, { IPAddress: string }>;
      };
    }>;
  } | null;
}

export interface ProxyDeps {
  runs: RunsRepo;
  streams: RunStreamRegistry;
  orchestrator: ProxyOrchestrator;
  procReader?: (pid: number) => string;
}

const defaultProcReader = (pid: number): string =>
  fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8');

function pickBridgeIp(inspect: {
  NetworkSettings: { IPAddress: string; Networks?: Record<string, { IPAddress: string }> };
}): string | null {
  if (inspect.NetworkSettings.IPAddress) return inspect.NetworkSettings.IPAddress;
  const nets = inspect.NetworkSettings.Networks;
  if (!nets) return null;
  for (const k of Object.keys(nets)) {
    const ip = nets[k]?.IPAddress;
    if (ip) return ip;
  }
  return null;
}

export function registerProxyRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  const procReader = deps.procReader ?? defaultProcReader;

  app.get('/api/runs/:id/listening-ports', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    if (!Number.isFinite(runId)) return reply.code(400).send({ error: 'invalid run id' });
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const container = deps.orchestrator.getLiveContainer(runId);
    if (!container) return reply.code(409).send({ error: `run ${runId} is not running` });
    const inspect = await container.inspect();
    const pid = inspect.State.Pid;
    if (!pid) return reply.code(409).send({ error: 'container has no pid' });
    let text: string;
    try { text = procReader(pid); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `read /proc failed: ${msg}` });
    }
    return reply.send({ ports: parseProcNetTcp(text) });
  });

  app.get('/api/runs/:id/proxy/:port', { websocket: true }, async (socket: WebSocket, req) => {
    const { id, port } = req.params as { id: string; port: string };
    const runId = Number(id);
    const targetPort = Number(port);
    if (!Number.isFinite(runId)) return socket.close(4004, 'invalid run id');
    if (!Number.isFinite(targetPort) || targetPort <= 0 || targetPort > 65535) {
      return socket.close(4004, 'invalid port');
    }
    const run = deps.runs.get(runId);
    if (!run) return socket.close(4004, 'run not found');
    const container = deps.orchestrator.getLiveContainer(runId);
    if (!container) return socket.close(4009, 'run not running');
    let inspect: Awaited<ReturnType<typeof container.inspect>>;
    try { inspect = await container.inspect(); }
    catch { return socket.close(1011, 'inspect failed'); }
    const ip = pickBridgeIp(inspect);
    if (!ip) return socket.close(1011, 'no bridge ip');

    const tcp = net.connect(targetPort, ip);
    let closed = false;
    let stateUnsub: () => void = () => {};
    const closeBoth = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      try { socket.close(code, reason); } catch { /* noop */ }
      tcp.destroy();
      stateUnsub();
    };

    tcp.on('error', () => closeBoth(1011, 'upstream error'));
    tcp.on('end', () => closeBoth(1000, 'upstream end'));
    tcp.on('data', (chunk: Buffer) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(chunk, { binary: true });
      // Backpressure: pause if WS send buffer is filling up.
      if (socket.bufferedAmount > 1 << 20) tcp.pause();
    });

    // WS→TCP backpressure: pause the underlying WS socket when the TCP write
    // buffer is full, and resume once the TCP socket drains.
    let wsPaused = false;
    const pauseWs = () => {
      if (!wsPaused) {
        // ws WebSocket exposes the underlying net.Socket as _socket.
        const underlying = (socket as unknown as { _socket?: net.Socket })._socket;
        underlying?.pause();
        wsPaused = true;
      }
    };
    const resumeWs = () => {
      if (wsPaused) {
        const underlying = (socket as unknown as { _socket?: net.Socket })._socket;
        underlying?.resume();
        wsPaused = false;
      }
    };
    tcp.on('drain', resumeWs);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return; // text frames are not part of this protocol
      const ok = tcp.write(data);
      if (!ok) pauseWs();
    });
    socket.on('close', () => closeBoth(1000, 'client closed'));
    socket.on('error', () => closeBoth(1011, 'ws error'));

    // Drain poll: resume TCP once buffered WS data drops.
    const drain = setInterval(() => {
      if (closed) { clearInterval(drain); return; }
      if (tcp.isPaused() && socket.bufferedAmount < 1 << 18) tcp.resume();
    }, 50);
    socket.on('close', () => clearInterval(drain));

    // State-driven close. Subscribe AFTER closeBoth/stateUnsub are defined so
    // an immediate replay of a non-running frame can call closeBoth safely.
    // Use a `triggered` flag to handle the synchronous-replay race: if the
    // listener fires during subscribe() itself, stateUnsub is still the no-op
    // initializer at that point, so we call the real unsub explicitly after
    // subscribe() returns.
    let triggered = false;
    stateUnsub = deps.streams.getOrCreateState(runId).subscribe((frame) => {
      // 'running' and 'waiting' both have a live container — the agent is just
      // blocked on user input in 'waiting', and the same listening ports are
      // still there. Every other state means the container is gone or going.
      if (frame.state !== 'running' && frame.state !== 'waiting') {
        triggered = true;
        closeBoth(1001, 'run ended');
      }
    });
    if (triggered) stateUnsub();
  });
}
