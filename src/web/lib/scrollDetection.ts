import type { Terminal as Xterm } from '@xterm/xterm';

export const NEAR_TOP_LINES = 100;

export interface ScrollSample {
  atBottom: boolean;
  nearTop: boolean;
  viewportTopLine: number;
}

export function detectScroll(term: Xterm): ScrollSample {
  const buf = term.buffer.active;
  const baseY = buf.baseY;
  const viewportY = buf.viewportY;
  return {
    atBottom: viewportY >= baseY,
    nearTop: baseY > 0 && viewportY < NEAR_TOP_LINES,
    viewportTopLine: viewportY,
  };
}
