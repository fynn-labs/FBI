import { useState } from 'react';
import type { RunState, ListeningPort } from '@shared/types.js';
import { Button } from '@ui/primitives/Button.js';
import { detectPlatform, type Platform } from './detectPlatform.js';

const OS_LABEL: Record<Platform['os'], string> = { darwin: 'macOS', linux: 'Linux' };
const ALL: Platform[] = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
];

function platformKey(p: Platform): string { return `${p.os}/${p.arch}`; }

function hintFor(state: RunState, hasPorts: boolean): string | null {
  if (state === 'queued') return 'run is queued';
  if (state === 'awaiting_resume') return 'run is paused awaiting token resume';
  if (state === 'succeeded' || state === 'failed' || state === 'cancelled') return 'run ended';
  if (state === 'running' && !hasPorts) return "No listening ports yet — the agent hasn't started a server.";
  return null;
}

function detectFromNavigator(): Platform {
  if (typeof navigator === 'undefined') return { os: 'darwin', arch: 'arm64' };
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  if (uaData?.platform) {
    // Client Hints "architecture" needs getHighEntropyValues(), which is async.
    // For v1.1 we only use the sync `platform` and fall back to userAgent for arch.
    return detectPlatform(navigator.userAgent);
  }
  return detectPlatform(navigator.userAgent);
}

export interface TunnelTabProps {
  runId: number;
  runState: RunState;
  origin: string;
  ports: readonly ListeningPort[];
  detected?: Platform;
}

export function TunnelTab({ runId, runState, origin, ports, detected }: TunnelTabProps) {
  const plat = detected ?? detectFromNavigator();
  const [showOther, setShowOther] = useState(false);
  const command = `fbi-tunnel ${origin} ${runId}`;
  const isRunning = runState === 'running';
  const hint = hintFor(runState, ports.length > 0);

  async function copy() {
    try { await navigator.clipboard.writeText(command); }
    catch { /* no-op; user can select+copy */ }
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-[13px] px-2 py-1 rounded-sm bg-surface-raised border border-border">
          {command}
        </code>
        <Button variant="secondary" size="sm" onClick={copy} disabled={!isRunning} aria-label="Copy command">
          Copy
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <a
          className={`inline-flex items-center gap-1.5 font-medium rounded-md border px-3 py-1.5 text-xs ${
            isRunning ? 'bg-accent text-surface border-accent hover:bg-accent-strong'
                       : 'bg-surface-raised text-text-faint border-border cursor-not-allowed pointer-events-none'
          }`}
          href={`/api/cli/fbi-tunnel/${plat.os}/${plat.arch}`}
          download
          aria-label={`Download fbi-tunnel for ${OS_LABEL[plat.os]} (${plat.arch})`}
        >
          Download fbi-tunnel for {OS_LABEL[plat.os]} ({plat.arch})
        </a>
        <button
          type="button"
          className="text-[13px] text-text-faint hover:text-text underline"
          onClick={() => setShowOther((v) => !v)}
          aria-expanded={showOther}
        >
          other platforms {showOther ? '▴' : '▾'}
        </button>
      </div>

      {showOther && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {ALL.filter((p) => platformKey(p) !== platformKey(plat)).map((p) => (
            <li key={platformKey(p)}>
              <a className="text-accent hover:text-accent-strong underline"
                 href={`/api/cli/fbi-tunnel/${p.os}/${p.arch}`}
                 download
                 aria-label={`${p.os}/${p.arch}`}>
                {p.os}/{p.arch}
              </a>
            </li>
          ))}
        </ul>
      )}

      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint pb-1 border-b border-border mb-1">
          Listening ports
        </h3>
        {hint ? (
          <p className="text-[13px] text-text-faint p-2">{hint}</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-text-faint text-[12px] uppercase tracking-[0.08em]">
              <tr className="border-b border-border">
                <th className="text-left px-2 py-1 font-semibold">remote port</th>
                <th className="text-left px-2 py-1 font-semibold">note</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((p) => (
                <tr key={p.port} className="border-b border-border last:border-0">
                  <td className="px-2 py-1 font-mono">{p.port}</td>
                  <td className="px-2 py-1 font-mono text-text-faint" />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
