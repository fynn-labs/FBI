/**
 * xterm_ref.mjs — @xterm/headless reference parser for the diff harness.
 *
 * Reads raw PTY bytes from stdin, feeds them through @xterm/headless, and
 * dumps a normalized JSON grid representation to stdout.  The Rust diff
 * harness feeds the same bytes through fbi-term-core's Parser and compares
 * the two JSON dumps cell-by-cell.
 *
 * Usage:
 *   node xterm_ref.mjs <cols> <rows> < bytes.bin > grid.json
 *
 * Color encoding (must match Parser::dump_normalized_grid on the Rust side):
 *
 *   Default fg  → 256  (mirrors alacritty NamedColor::Foreground discriminant)
 *   Default bg  → 257  (mirrors alacritty NamedColor::Background discriminant)
 *   Named P16   → 0-15 (ANSI color index)
 *   P256        → 0-255 (palette index)
 *   RGB true    → (r<<16)|(g<<8)|b as unsigned integer (0..16777215)
 *
 * Wide-char normalization:
 *   Wide characters occupy two cells in xterm (width=2 then width=0 spacer).
 *   Emojis may be width=1 in xterm but width=2 in alacritty due to different
 *   Unicode width tables.  To handle both cases uniformly on BOTH sides:
 *
 *   Decision: spacer cells (width=0) are SKIPPED entirely.  This means each
 *   wide character emits exactly ONE cell.  The Rust side does the same
 *   (skips WIDE_CHAR_SPACER cells).  Column indices are logical character
 *   positions, not physical terminal columns — but since we apply the same
 *   normalization on both sides, comparisons are still meaningful.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve @xterm/headless relative to the workspace root (4 levels up from
// tests/support/ inside the fbi-term-core crate).
const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HEADLESS_PATH = resolve(WORKSPACE_ROOT, 'node_modules/@xterm/headless/lib-headless/xterm-headless.js');

const require = createRequire(import.meta.url);
const { Terminal } = require(HEADLESS_PATH);

const cols = Number(process.argv[2] || 80);
const rows = Number(process.argv[3] || 24);

// ── Constants ────────────────────────────────────────────────────────────────

// xterm.js color mode constants returned by getFgColorMode() / getBgColorMode().
// These are 28-bit values: 0x1000000, 0x2000000, 0x3000000 (7 hex digits).
const CM_DEFAULT = 0x0000000; // getFgColor() === -1 when default
const CM_P16     = 0x1000000; // named/ANSI 16 colors, value is 0-15
const CM_P256    = 0x2000000; // 256-color palette, value is 0-255
const CM_RGB     = 0x3000000; // 24-bit true color, value is (r<<16)|(g<<8)|b

// Sentinel values for default fg/bg (must match Rust dump).
const DEFAULT_FG = 256;
const DEFAULT_BG = 257;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert xterm.js color+mode pair to our canonical JSON integer.
 * `isDefaultFg` distinguishes which sentinel to use for the default color.
 */
function encodeColor(color, mode, isDefaultFg) {
  if (mode === CM_DEFAULT) {
    return isDefaultFg ? DEFAULT_FG : DEFAULT_BG;
  }
  if (mode === CM_P16 || mode === CM_P256) {
    // value is the palette index directly (0-15 for P16, 0-255 for P256).
    return color;
  }
  if (mode === CM_RGB) {
    // value is packed 24-bit RGB: (r<<16)|(g<<8)|b.
    return color;
  }
  // Fallback: treat unknown mode as default.
  return isDefaultFg ? DEFAULT_FG : DEFAULT_BG;
}

/**
 * Returns true if `cell` is a default (blank) cell with no content or
 * non-default attributes.
 */
function isDefaultCell(c) {
  return (
    c.ch === ' ' &&
    c.fg === DEFAULT_FG &&
    c.bg === DEFAULT_BG &&
    !c.bold &&
    !c.italic &&
    !c.underline &&
    !c.inverse
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const bytes = await readStdin();

const term = new Terminal({
  cols,
  rows,
  scrollback: 0,
  allowProposedApi: true,
});

// feed the full byte stream synchronously then wait for the write callback.
await new Promise((resolve) => term.write(bytes, resolve));

const buf = term.buffer.active;

const out = {
  cols,
  rows,
  cursor_row: buf.cursorY,
  cursor_col: buf.cursorX,
  alt_screen: term.buffer.active === term.buffer.alternate,
  rows_data: [],
};

for (let r = 0; r < rows; r++) {
  const line = buf.getLine(r);
  const cells = [];

  if (line) {
    for (let c = 0; c < cols; c++) {
      const cell = line.getCell(c);
      if (!cell) {
        cells.push({ ch: ' ', fg: DEFAULT_FG, bg: DEFAULT_BG, bold: false, italic: false, underline: false, inverse: false });
        continue;
      }

      const width = cell.getWidth();

      if (width === 0) {
        // Spacer cell for a wide char — skip entirely.
        // The preceding wide-char cell already emitted the character.
        // (See wide-char normalization note at top of file.)
        continue;
      }

      const charStr = cell.getChars();
      const fgColor = cell.getFgColor();
      const bgColor = cell.getBgColor();
      const fgMode = cell.getFgColorMode();
      const bgMode = cell.getBgColorMode();

      const fg = encodeColor(fgColor, fgMode, true);
      const bg = encodeColor(bgColor, bgMode, false);
      const bold = !!cell.isBold();
      const italic = !!cell.isItalic();
      const underline = !!cell.isUnderline();
      const inverse = !!cell.isInverse();

      const ch = charStr || ' ';
      cells.push({ ch, fg, bg, bold, italic, underline, inverse });
    }
  }

  // Trim trailing default cells.
  while (cells.length > 0 && isDefaultCell(cells[cells.length - 1])) {
    cells.pop();
  }

  out.rows_data.push(cells);
}

// Trim trailing empty rows at the end of rows_data.
while (out.rows_data.length > 0 && out.rows_data[out.rows_data.length - 1].length === 0) {
  out.rows_data.pop();
}
// Pad back to rows length with empty arrays so indices are stable.
while (out.rows_data.length < rows) {
  out.rows_data.push([]);
}

process.stdout.write(JSON.stringify(out));
