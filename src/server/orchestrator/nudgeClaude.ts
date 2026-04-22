export interface NudgeClaudeOptions {
  /** Write a byte to the container's TTY stdin. */
  writeStdin: (bytes: Uint8Array) => void;
  /** Force-kill the container. Called as a last-resort fallback. */
  killContainer: () => Promise<void>;
  /** Surface a human-readable message to the run's log stream. */
  log: (msg: string) => void;
  /**
   * Delay between the first and second Ctrl-C byte, in ms. Claude Code's TUI
   * treats a single Ctrl-C as "clear input / confirm exit" and only exits on
   * a second Ctrl-C within a short window — a single 0x03 leaves Claude running.
   */
  secondCtrlCDelayMs?: number;
  /** If Claude still hasn't exited after this long, SIGKILL the container. */
  killAfterMs?: number;
  /** Timer factory (injectable for tests). */
  setTimeout?: typeof globalThis.setTimeout;
}

const ETX = 0x03; // Ctrl-C

/**
 * Coax Claude out of the rate-limit message without killing the container
 * so supervisor.sh can still commit+push the WIP. Sends two Ctrl-C bytes
 * (double-tap) and schedules a container kill as a safety net.
 */
export function nudgeClaudeToExit(opts: NudgeClaudeOptions): void {
  const setT = opts.setTimeout ?? globalThis.setTimeout;
  const secondDelay = opts.secondCtrlCDelayMs ?? 250;
  const killDelay = opts.killAfterMs ?? 30_000;

  opts.log('\n[fbi] rate-limit message detected in stream; sending ^C^C to claude\n');

  const sendCtrlC = () => {
    try { opts.writeStdin(Uint8Array.of(ETX)); } catch { /* stream closed */ }
  };
  sendCtrlC();
  setT(sendCtrlC, secondDelay).unref?.();
  setT(() => {
    opts.killContainer().catch(() => { /* already stopped */ });
  }, killDelay).unref?.();
}
