// @xterm/headless is a CJS bundle whose minified wrapper defeats Node's
// named-export detection; import the default and destructure.
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
const { Terminal } = headless;
type Terminal = InstanceType<typeof Terminal>;

/**
 * Scans a byte stream for ANSI mode-setting sequences and tracks the
 * latest value of each. At snapshot time, emit() re-emits these sequences
 * so the client sees an up-to-date set of modes at the server's *current*
 * dims.
 *
 * SerializeAddon preserves cell contents, alt-screen flag, and origin mode,
 * but NOT DECSTBM (scroll region), DECTCEM (cursor visibility), DECAWM
 * (auto-wrap), or bracketed-paste / mouse-reporting modes. Without these,
 * a TUI that redraws using relative cursor moves drifts by one or more rows
 * after snapshot replay — the original symptom this class was added to fix.
 *
 * The previous implementation buffered the first 4 KB of bytes verbatim and
 * replayed them as a preamble. That froze the modes at whatever dims the
 * PTY had at startup (default 120×40) and could slice mid-escape-sequence at
 * the 4 KB boundary. Parsing the stream and re-emitting avoids both traps.
 */
class ModeScanner {
  // DEC private modes (CSI ? Ps h/l)
  cursorVisible = true;     // ?25  — DECTCEM (default on per xterm)
  autoWrap = true;          // ?7   — DECAWM  (default on per xterm)
  altScreen = false;        // ?1049 | ?1047 | ?47
  bracketedPaste = false;   // ?2004
  focusReporting = false;   // ?1004
  inBandResize = false;     // ?2031
  mouseMode = 0;            // one of 0 | 1000 | 1002 | 1003
  mouseExt = 0;             // one of 0 | 1006 | 1015 | 1016
  // Scroll region (CSI Pt ; Pb r) — null = default (full screen)
  stbmTop: number | null = null;
  stbmBottom: number | null = null;

  // Parser state (CSI state machine that survives chunk boundaries)
  private state: 'normal' | 'esc' | 'csi' = 'normal';
  private csiPrivate = '';
  private csiParams = '';

  scan(data: Uint8Array): void {
    for (let i = 0; i < data.byteLength; i++) {
      const b = data[i];
      switch (this.state) {
        case 'normal':
          if (b === 0x1b) this.state = 'esc';
          break;
        case 'esc':
          if (b === 0x5b /* [ */) {
            this.state = 'csi';
            this.csiPrivate = '';
            this.csiParams = '';
          } else {
            // Non-CSI escape (e.g. ESC 7 = DECSC) — we don't track these.
            this.state = 'normal';
          }
          break;
        case 'csi':
          if (this.csiPrivate === '' && this.csiParams === '' && b >= 0x3c && b <= 0x3f) {
            // Private-prefix byte (< = > ?). We only care about '?'.
            this.csiPrivate = String.fromCharCode(b);
          } else if ((b >= 0x30 && b <= 0x39) /* digit */ || b === 0x3b /* ; */ || b === 0x3a /* : */) {
            this.csiParams += String.fromCharCode(b);
          } else if (b >= 0x40 && b <= 0x7e) {
            // Final byte
            this.dispatch(String.fromCharCode(b));
            this.state = 'normal';
          } else if (b >= 0x20 && b <= 0x2f) {
            // Intermediate byte — ignore and keep parsing
          } else {
            // Control or unexpected byte — abort
            this.state = 'normal';
          }
          break;
      }
    }
  }

  private dispatch(final: string): void {
    if (this.csiPrivate === '?' && (final === 'h' || final === 'l')) {
      const set = final === 'h';
      for (const p of this.csiParams.split(';')) {
        const n = Number(p);
        if (!Number.isFinite(n)) continue;
        switch (n) {
          case 7: this.autoWrap = set; break;
          case 25: this.cursorVisible = set; break;
          case 47: case 1047: case 1049: this.altScreen = set; break;
          case 1004: this.focusReporting = set; break;
          case 2004: this.bracketedPaste = set; break;
          case 2031: this.inBandResize = set; break;
          case 1000: case 1002: case 1003:
            if (set) this.mouseMode = n;
            else if (this.mouseMode === n) this.mouseMode = 0;
            break;
          case 1006: case 1015: case 1016:
            if (set) this.mouseExt = n;
            else if (this.mouseExt === n) this.mouseExt = 0;
            break;
          default: /* not tracked */
        }
      }
    } else if (this.csiPrivate === '' && final === 'r') {
      // DECSTBM — scroll region
      const parts = this.csiParams.split(';');
      const t = parts[0] !== undefined && parts[0] !== '' ? Number(parts[0]) : NaN;
      const b = parts[1] !== undefined && parts[1] !== '' ? Number(parts[1]) : NaN;
      if (Number.isFinite(t) && Number.isFinite(b)) {
        this.stbmTop = t;
        this.stbmBottom = b;
      } else {
        // Empty params reset to full screen
        this.stbmTop = null;
        this.stbmBottom = null;
      }
    }
  }

  /** ANSI that replays the current mode state. Scroll region is clamped
   *  to the provided row count so a stale DECSTBM captured at smaller
   *  dims still resolves to a valid range on replay. */
  emit(rows: number): string {
    let out = '';
    // Scroll region first so subsequent cursor ops observe it.
    if (this.stbmTop !== null && this.stbmBottom !== null) {
      const top = Math.max(1, Math.min(rows, this.stbmTop));
      const bot = Math.max(top, Math.min(rows, this.stbmBottom));
      out += `\x1b[${top};${bot}r`;
    } else {
      out += '\x1b[r';
    }
    out += this.autoWrap ? '\x1b[?7h' : '\x1b[?7l';
    out += this.cursorVisible ? '\x1b[?25h' : '\x1b[?25l';
    if (this.bracketedPaste) out += '\x1b[?2004h';
    if (this.focusReporting) out += '\x1b[?1004h';
    if (this.inBandResize) out += '\x1b[?2031h';
    if (this.mouseMode) out += `\x1b[?${this.mouseMode}h`;
    if (this.mouseExt) out += `\x1b[?${this.mouseExt}h`;
    return out;
  }
}

/**
 * Server-side virtual terminal. Holds a headless xterm that parses every
 * byte emitted by the PTY, so we always know "the current screen" and can
 * replay it to a fresh client on connect or on refocus.
 */
export class ScreenState {
  private term: Terminal;
  private serializer: SerializeAddon;
  private modes = new ModeScanner();

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
    this.modes.scan(data);
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
  }

  /** ANSI that replays the current mode state (scroll region, cursor
   *  visibility, auto-wrap, mouse / bracketed-paste / focus reporting
   *  modes) at the screen's current rows. Append AFTER serialize() when
   *  building a snapshot so modes are correct for the live bytes that
   *  follow. */
  modesAnsi(): string {
    return this.modes.emit(this.term.rows);
  }

  serialize(): string {
    return this.serializer.serialize({ scrollback: 0 });
  }

  dispose(): void {
    this.serializer.dispose();
    this.term.dispose();
  }
}
