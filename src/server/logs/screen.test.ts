import { describe, it, expect } from 'vitest';
import { ScreenState } from './screen.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('ScreenState', () => {
  it('round-trips a plain-text write: feeding serialize() into a fresh ScreenState yields the same serialize()', async () => {
    const a = new ScreenState(80, 24);
    await a.write(enc('hello world\r\n'));
    const ansi = a.serialize();
    const b = new ScreenState(80, 24);
    await b.write(enc(ansi));
    expect(b.serialize()).toBe(ansi);
    a.dispose(); b.dispose();
  });

  it('is parser-safe across chunk boundaries: writing bytes in two halves equals writing them whole', async () => {
    const payload = enc('\x1b[31mred\x1b[0m text\r\n');
    const whole = new ScreenState(80, 24);
    await whole.write(payload);

    const split = new ScreenState(80, 24);
    const mid = Math.floor(payload.byteLength / 2);
    await split.write(payload.subarray(0, mid));
    await split.write(payload.subarray(mid));

    expect(split.serialize()).toBe(whole.serialize());
    whole.dispose(); split.dispose();
  });

  it('resize() updates cols/rows and subsequent serialize reflects new dimensions', async () => {
    const s = new ScreenState(80, 24);
    await s.write(enc('before\r\n'));
    s.resize(120, 40);
    await s.write(enc('after\r\n'));
    expect(s.cols).toBe(120);
    expect(s.rows).toBe(40);
    const ansi = s.serialize();
    const b = new ScreenState(120, 40);
    await b.write(enc(ansi));
    expect(b.serialize()).toBe(ansi);
    s.dispose(); b.dispose();
  });

  it('serialize() excludes scrollback by default (scrollback:0)', async () => {
    const s = new ScreenState(10, 3);
    for (let i = 0; i < 10; i++) await s.write(enc(`line${i}\r\n`));
    const ansi = s.serialize();
    expect(ansi.includes('line0')).toBe(false);
    s.dispose();
  });
});
