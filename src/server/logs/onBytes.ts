import type { LogStore } from './store.js';
import type { Broadcaster } from './broadcaster.js';
import type { ScreenState } from './screen.js';

/**
 * Build the fan-out callback for PTY bytes. Every orchestrator path that
 * consumes PTY output (launch, resume, continueRun, reattach) must use
 * this — feeding one sink but not another is the class of bug that
 * caused the "continueRun doesn't update ScreenState" drift.
 *
 * `screen.write` returns a promise (xterm-headless parser is async); we
 * don't await — xterm preserves write ordering internally, and snapshot
 * callers tolerate "at most one frame stale."
 */
export function makeOnBytes(
  store: LogStore,
  broadcaster: Broadcaster,
  screen: ScreenState,
): (chunk: Uint8Array) => void {
  return (chunk) => {
    store.append(chunk);
    broadcaster.publish(chunk);
    void screen.write(chunk).catch(() => {});
  };
}
