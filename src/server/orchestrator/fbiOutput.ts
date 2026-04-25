// ANSI styled output helpers for orchestrator messages.
// Mirrors the bash _fbi_* helpers in supervisor.sh.
// Both stdout and stderr flow through the same PTY attach stream,
// so styling both is safe.

const R      = '\x1b[0m';
const GRAY   = '\x1b[90m';
const WHITE  = '\x1b[97m';
const DIM    = '\x1b[2m';
const AMBER  = '\x1b[33m';
const RED    = '\x1b[31m';
const BLUE   = '\x1b[34m';
const GREEN  = '\x1b[32m';

export const fbi = {
  status(msg: string): string {
    return `${GRAY}○${R}  ${WHITE}${msg}${R}\n`;
  },

  statusKV(key: string, val: string): string {
    return `${GRAY}○${R}  ${WHITE}${key}${R}  ${DIM}${val}${R}\n`;
  },

  warn(msg: string): string {
    return `${AMBER}⚠${R}  ${AMBER}${msg}${R}\n`;
  },

  fatal(msg: string): string {
    return `${RED}✕${R}  ${RED}${msg}${R}\n`;
  },

  info(msg: string): string {
    return `${BLUE}◎${R}  ${BLUE}${msg}${R}\n`;
  },

  runState(state: 'succeeded' | 'failed' | 'cancelled'): string {
    const color  = state === 'succeeded' ? GREEN : state === 'failed' ? RED : AMBER;
    const symbol = state === 'succeeded' ? '●'   : state === 'failed' ? '✕' : '○';
    return `${GRAY}○${R}  run  ${color}${symbol} ${state}${R}\n`;
  },
};
