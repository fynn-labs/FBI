export interface ListeningPort {
  port: number;
  proto: 'tcp';
}

// Linux kernel TCP state constant (TCP_LISTEN). See net/tcp_states.h.
const LISTEN_STATE = '0A';

export function parseProcNetTcp(text: string): ListeningPort[] {
  const seen = new Set<number>();
  const out: ListeningPort[] = [];
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('sl')) continue;
    // Format: "  N: <local_addr> <rem_addr> <st> ..."
    const parts = line.split(/\s+/);
    // After splitting, parts[0] is "N:", parts[1] is local_address, parts[2] rem, parts[3] state.
    if (parts.length < 4) continue;
    const local = parts[1];
    const state = parts[3];
    if (state !== LISTEN_STATE) continue; // not LISTEN
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const portHex = local.slice(colon + 1);
    const port = parseInt(portHex, 16);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    out.push({ port, proto: 'tcp' });
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}
