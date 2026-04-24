import { describe, it, expect } from 'vitest';
import { detectScroll } from './scrollDetection.js';

function mkTerm(baseY: number, viewportY: number, rows = 40) {
  return { rows, buffer: { active: { baseY, viewportY } } } as unknown as import('@xterm/xterm').Terminal;
}

describe('detectScroll', () => {
  it('atBottom when viewportY === baseY', () => {
    expect(detectScroll(mkTerm(500, 500)).atBottom).toBe(true);
  });

  it('atBottom false when viewportY < baseY', () => {
    expect(detectScroll(mkTerm(500, 499)).atBottom).toBe(false);
  });

  it('atBottom true when viewportY > baseY (overscroll / trackpad momentum)', () => {
    expect(detectScroll(mkTerm(500, 501)).atBottom).toBe(true);
  });

  it('nearTop true when viewportY < NEAR_TOP_LINES and baseY > 0', () => {
    expect(detectScroll(mkTerm(500, 50)).nearTop).toBe(true);
    expect(detectScroll(mkTerm(500, 99)).nearTop).toBe(true);
    expect(detectScroll(mkTerm(500, 100)).nearTop).toBe(false);
  });

  it('nearTop false when baseY === 0 (nothing older to load)', () => {
    expect(detectScroll(mkTerm(0, 0)).nearTop).toBe(false);
  });

  it('viewportTopLine equals viewportY', () => {
    expect(detectScroll(mkTerm(500, 123)).viewportTopLine).toBe(123);
  });
});
