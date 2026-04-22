// @xterm/headless is a CJS bundle whose minified wrapper defeats Node's
// named-export detection; import the default and destructure.
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
const { Terminal } = headless;
type Terminal = InstanceType<typeof Terminal>;

/**
 * Server-side virtual terminal. Holds a headless xterm that parses every byte
 * emitted by the PTY, so we always know "the current screen" and can replay
 * it to a fresh client on connect or on refocus. This replaces raw-log
 * replay as the live-view source of truth.
 */
// SerializeAddon captures cell contents, alt-screen flag, and origin mode,
// but NOT scroll region (DECSTBM) or cursor visibility (DECTCEM). TUIs like
// Claude Code set those at startup so the input footer stays pinned while
// the chat area scrolls. To preserve those modes across snapshot replay,
// we keep a small prefix of the PTY's first bytes (where setup happens) and
// prepend them to every snapshot.
const PREAMBLE_CAP = 4 * 1024;

export class ScreenState {
  private term: Terminal;
  private serializer: SerializeAddon;
  private preamble: Uint8Array = new Uint8Array(0);

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }

  write(data: Uint8Array): Promise<void> {
    if (this.preamble.byteLength < PREAMBLE_CAP) {
      const room = PREAMBLE_CAP - this.preamble.byteLength;
      const slice = data.subarray(0, Math.min(data.byteLength, room));
      const merged = new Uint8Array(this.preamble.byteLength + slice.byteLength);
      merged.set(this.preamble, 0);
      merged.set(slice, this.preamble.byteLength);
      this.preamble = merged;
    }
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
  }

  /** ANSI of the captured preamble bytes — the first PREAMBLE_CAP of the
   *  PTY's output, where TUIs typically set scroll region (DECSTBM) and
   *  cursor visibility (DECTCEM), neither of which SerializeAddon
   *  preserves. Callers building a snapshot for replay should send
   *  `preambleAnsi() + serialize()` so the client sees the modes too. */
  preambleAnsi(): string {
    return new TextDecoder().decode(this.preamble);
  }

  serialize(): string {
    return this.serializer.serialize({ scrollback: 0 });
  }

  dispose(): void {
    this.serializer.dispose();
    this.term.dispose();
  }
}
