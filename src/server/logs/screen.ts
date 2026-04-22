import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/**
 * Server-side virtual terminal. Holds a headless xterm that parses every byte
 * emitted by the PTY, so we always know "the current screen" and can replay
 * it to a fresh client on connect or on refocus. This replaces raw-log
 * replay as the live-view source of truth.
 */
export class ScreenState {
  private term: Terminal;
  private serializer: SerializeAddon;

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
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
  }

  serialize(): string {
    return this.serializer.serialize({ scrollback: 0 });
  }

  dispose(): void {
    this.serializer.dispose();
    this.term.dispose();
  }
}
