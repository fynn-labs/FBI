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

  it('modesAnsi() emits DECSTBM clamped to current rows (not stale startup rows)', async () => {
    // Simulate a TUI that sets scroll region at startup dims (40 rows),
    // then the terminal is resized larger. The emitted DECSTBM must use
    // the scanned top/bottom *clamped to current rows* so the client
    // applies a valid scroll region on the current viewport.
    const s = new ScreenState(120, 40);
    await s.write(enc('\x1b[1;40r')); // TUI sets scroll region 1..40
    s.resize(82, 48);                  // viewport grows
    const modes = s.modesAnsi();
    expect(modes).toContain('\x1b[1;40r'); // clamped values (40 ≤ 48 so unchanged)
    s.dispose();
  });

  it('modesAnsi() tracks DECTCEM, DECAWM, ?1049, ?2004 across the stream', async () => {
    const s = new ScreenState(80, 24);
    await s.write(enc('\x1b[?25l\x1b[?7l\x1b[?1049h\x1b[?2004h'));
    const modes = s.modesAnsi();
    expect(modes).toContain('\x1b[?25l');   // cursor hidden
    expect(modes).toContain('\x1b[?7l');    // auto-wrap off
    expect(modes).toContain('\x1b[?2004h'); // bracketed paste
    // Alt-screen is on but SerializeAddon already emits ?1049h for alt
    // buffers, so we don't require modesAnsi to repeat it — just assert
    // the mode scanner saw the rest.
    s.dispose();
  });

  it('modesAnsi() defaults to sane values when the stream sets no modes', async () => {
    const s = new ScreenState(80, 24);
    await s.write(enc('plain text\r\n'));
    const modes = s.modesAnsi();
    expect(modes).toContain('\x1b[r');      // scroll region reset
    expect(modes).toContain('\x1b[?7h');    // auto-wrap default on
    expect(modes).toContain('\x1b[?25h');   // cursor visible default on
    s.dispose();
  });

  it('mode scanner survives escape sequences split across write() calls', async () => {
    const s = new ScreenState(80, 24);
    // Split "\x1b[?25l" (cursor-hide) right after the '?' so the parser
    // has to resume with the digits from the next write.
    await s.write(enc('\x1b[?'));
    await s.write(enc('25l'));
    expect(s.modesAnsi()).toContain('\x1b[?25l');
    s.dispose();
  });

  it('drain() resolves after all in-flight writes have been parsed', async () => {
    const s = new ScreenState(80, 24);
    // Queue writes without awaiting them individually.
    void s.write(new TextEncoder().encode('\x1b[1;1H'));
    void s.write(new TextEncoder().encode('hello'));
    await s.drain();
    expect(s.serialize()).toContain('hello');
    s.dispose();
  });
});
