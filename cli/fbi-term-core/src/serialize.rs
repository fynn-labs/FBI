//! Grid → ANSI serializer for `Parser::snapshot()`.
//!
//! This module walks alacritty's `Grid<Cell>` and emits the minimum ANSI
//! byte string that, when written into a fresh xterm.js terminal at the
//! same dimensions, reproduces the source grid's visible content and
//! cursor position.
//!
//! # Design notes
//!
//! ## Why we trim trailing blank cells (per row)
//!
//! The grid is always `cols` wide regardless of how much the program has
//! written.  Emitting all trailing default-attribute spaces would bloat the
//! snapshot and make text diffs noisy.  We stop at the last non-blank cell
//! in each row instead.
//!
//! ## Why CUP is emitted last
//!
//! As we write characters the implicit cursor advances right (and wraps at
//! column boundaries).  Any relative move sequence would need to account for
//! that advance.  Emitting an absolute CUP (`\e[row;colH`) at the very end,
//! after all cell content is written, sidesteps the accounting entirely.
//!
//! ## SGR fidelity in this v1 serializer
//!
//! For the initial implementation we emit:
//!   - `\e[0m` reset when attributes return to default
//!   - foreground: named 3-bit/4-bit colors (SGR 30-37, 90-97) and 24-bit
//!     RGB (`\e[38;2;r;g;bm`), plus `\e[39m` (default fg)
//!   - background: same pattern (40-47, 100-107, `\e[48;2;r;g;bm`, `\e[49m`)
//!   - bold (`\e[1m`), italic (`\e[3m`), and reverse (`\e[7m`) flags
//!
//! Full SGR coalescing (combining multiple attribute changes into a single
//! CSI sequence) is left for a later pass once the diff harness (Phase 3)
//! can quantify fidelity gaps.  For now we emit one SGR change per cell
//! that needs it, which is correct if verbose.

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, GridCell};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

/// Serialize the visible grid of `term` into an ANSI replay string.
///
/// The returned string, when fed into a fresh `vte` parser driving an
/// `alacritty_terminal::Term` of the same dimensions, reproduces:
///   - every cell character (including wide / double-width characters)
///   - foreground / background colors and the bold, italic, reverse flags
///   - the final cursor position
///
/// Mode state (alt-screen, scroll region, DECTCEM, …) is *not* included
/// here — that is Task 1.4 (`ModePrefix`).
pub fn serialize_grid(term: &Term<VoidListener>) -> String {
    let grid = term.grid();
    let num_rows = grid.screen_lines();
    let num_cols = grid.columns();

    // Pre-allocate generously to avoid repeated re-allocs on typical
    // terminal content (80×24 ≈ ~2 KiB; 120×40 ≈ ~5 KiB).
    let mut out = String::with_capacity(num_rows * num_cols * 2);

    // Track the "current" SGR attribute state so we only emit escape
    // sequences on transitions.  We start in the default attribute state.
    let mut cur_attrs = AttrState::default();

    for row_idx in 0..num_rows {
        let line = Line(row_idx as i32);
        let row = &grid[line];

        // Find the last column that contains a non-default cell so we can
        // stop early and avoid emitting trailing spaces out to col 80.
        // "Non-default" means: non-space character OR non-default colors OR
        // non-empty flags.  We use alacritty's own `is_empty()` predicate
        // which encodes exactly that logic.
        let last_content_col = (0..num_cols)
            .rev()
            .find(|&c| !row[Column(c)].is_empty())
            .map(|c| c + 1) // exclusive upper bound
            .unwrap_or(0);

        for col_idx in 0..last_content_col {
            let cell = &row[Column(col_idx)];

            // Wide-char spacers are zero-width placeholders inserted by
            // alacritty to keep column accounting correct.  The actual glyph
            // is already in the preceding WIDE_CHAR cell; emitting the spacer
            // would shift every subsequent cell one column to the right.
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }

            // Emit SGR codes if this cell's attributes differ from the last
            // emitted state.
            let cell_attrs = AttrState::from_cell(cell);
            if cell_attrs != cur_attrs {
                emit_sgr(&mut out, &cur_attrs, &cell_attrs);
                cur_attrs = cell_attrs;
            }

            // Emit the cell character itself.  For wide chars the single
            // Unicode codepoint in `cell.c` already occupies two columns in
            // the terminal (that's why there's a spacer cell behind it).
            out.push(cell.c);

            // Also emit any zero-width combining characters attached to this
            // cell (e.g. combining diacritics).
            if let Some(zw) = cell.zerowidth() {
                for &ch in zw {
                    out.push(ch);
                }
            }
        }

        // Between rows: carriage-return + newline to advance to the next row.
        // We don't emit a trailing \r\n after the last row because that would
        // push the cursor one line too far down.
        if row_idx + 1 < num_rows {
            out.push_str("\r\n");
        }
    }

    // Reset SGR after all content so the final CUP and any subsequent text
    // see default attributes.
    if cur_attrs != AttrState::default() {
        out.push_str("\x1b[0m");
    }

    // Final CUP: place the cursor at its actual position.
    //
    // We emit this last because the character writes above have moved the
    // implicit cursor around and we want a single authoritative absolute
    // move rather than trying to account for every advance.
    //
    // CUP uses 1-indexed row/column.
    let cursor_point = grid.cursor.point;
    // `cursor_point.line` is 0-indexed (Line(0) = top of screen).
    // `cursor_point.column` is 0-indexed via Column(usize).
    let cursor_row = cursor_point.line.0 as usize + 1; // to 1-indexed
    let cursor_col = cursor_point.column.0 + 1; // to 1-indexed
    out.push_str(&format!("\x1b[{};{}H", cursor_row, cursor_col));

    out
}

// ── SGR attribute state ───────────────────────────────────────────────────────

/// The subset of SGR attributes we track for snapshot serialization.
///
/// We only track what we actually serialize; unknown / untracked attributes
/// (blink, underline style, etc.) are left for a later fidelity pass.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AttrState {
    fg: Color,
    bg: Color,
    bold: bool,
    italic: bool,
    reverse: bool,
}

impl Default for AttrState {
    fn default() -> Self {
        AttrState {
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            bold: false,
            italic: false,
            reverse: false,
        }
    }
}

impl AttrState {
    fn from_cell(cell: &Cell) -> Self {
        AttrState {
            fg: cell.fg,
            bg: cell.bg,
            bold: cell.flags.contains(Flags::BOLD),
            italic: cell.flags.contains(Flags::ITALIC),
            reverse: cell.flags.contains(Flags::INVERSE),
        }
    }
}

/// Emit the minimal SGR sequence(s) to transition from `prev` to `next`.
///
/// Strategy: if the new state is the default we emit a blanket `\e[0m`
/// reset.  Otherwise we reset first (to clear any attributes being turned
/// off) and then re-apply the non-default ones.  This is not maximally
/// compact but it is always correct and easy to verify.
///
/// A future pass can coalesce these into a single CSI sequence per cell.
fn emit_sgr(out: &mut String, prev: &AttrState, next: &AttrState) {
    let default = AttrState::default();

    if *next == default {
        // Everything going back to default — a plain reset suffices.
        out.push_str("\x1b[0m");
        return;
    }

    // If any previously-set attribute is being cleared, we need a reset
    // before re-applying.  It's simpler to always reset and re-apply than
    // to emit individual cancel codes (CancelBold, etc.).
    let needs_reset = (prev.bold && !next.bold)
        || (prev.italic && !next.italic)
        || (prev.reverse && !next.reverse)
        || (prev.fg != Color::Named(NamedColor::Foreground)
            && next.fg == Color::Named(NamedColor::Foreground))
        || (prev.bg != Color::Named(NamedColor::Background)
            && next.bg == Color::Named(NamedColor::Background));

    if needs_reset {
        out.push_str("\x1b[0m");
        // After a reset the effective state is now `default`; apply next
        // relative to that.
        emit_sgr_apply(out, &default, next);
    } else {
        // No need to reset; just apply the delta.
        emit_sgr_apply(out, prev, next);
    }
}

/// Emit SGR codes for attributes in `next` that differ from `prev`,
/// without any leading reset.
fn emit_sgr_apply(out: &mut String, prev: &AttrState, next: &AttrState) {
    // Bold.
    if next.bold && !prev.bold {
        out.push_str("\x1b[1m");
    }
    // Italic.
    if next.italic && !prev.italic {
        out.push_str("\x1b[3m");
    }
    // Reverse.
    if next.reverse && !prev.reverse {
        out.push_str("\x1b[7m");
    }

    // Foreground color.
    if next.fg != prev.fg {
        emit_color_sgr(out, next.fg, false);
    }
    // Background color.
    if next.bg != prev.bg {
        emit_color_sgr(out, next.bg, true);
    }
}

/// Emit a single SGR sequence for a color.
///
/// `is_bg` selects the background (40–47 / 100–107 / 48;2;…) range
/// rather than the foreground (30–37 / 90–97 / 38;2;…) range.
fn emit_color_sgr(out: &mut String, color: Color, is_bg: bool) {
    match color {
        Color::Named(nc) => {
            // Map alacritty's NamedColor to its ANSI SGR code.
            // Standard 8 colors: 30-37 fg, 40-47 bg.
            // Bright 8 colors:   90-97 fg, 100-107 bg.
            // Default fg/bg:     39 / 49.
            // Dim colors map to their standard counterparts for replay
            // purposes (the Dim flag is handled separately via SGR 2 in
            // future fidelity work; for v1 we ignore the Dim variant here).
            match nc {
                NamedColor::Black => emit_named_color(out, 0, is_bg, false),
                NamedColor::Red => emit_named_color(out, 1, is_bg, false),
                NamedColor::Green => emit_named_color(out, 2, is_bg, false),
                NamedColor::Yellow => emit_named_color(out, 3, is_bg, false),
                NamedColor::Blue => emit_named_color(out, 4, is_bg, false),
                NamedColor::Magenta => emit_named_color(out, 5, is_bg, false),
                NamedColor::Cyan => emit_named_color(out, 6, is_bg, false),
                NamedColor::White => emit_named_color(out, 7, is_bg, false),
                NamedColor::BrightBlack => emit_named_color(out, 0, is_bg, true),
                NamedColor::BrightRed => emit_named_color(out, 1, is_bg, true),
                NamedColor::BrightGreen => emit_named_color(out, 2, is_bg, true),
                NamedColor::BrightYellow => emit_named_color(out, 3, is_bg, true),
                NamedColor::BrightBlue => emit_named_color(out, 4, is_bg, true),
                NamedColor::BrightMagenta => emit_named_color(out, 5, is_bg, true),
                NamedColor::BrightCyan => emit_named_color(out, 6, is_bg, true),
                NamedColor::BrightWhite => emit_named_color(out, 7, is_bg, true),
                // Bright variants of the special foreground/background names.
                NamedColor::BrightForeground => {
                    // Treated as bold foreground; for SGR purposes use default fg.
                    let code = if is_bg { 49 } else { 39 };
                    out.push_str(&format!("\x1b[{}m", code));
                },
                // Default fg/bg and cursor — emit the "default" code.
                NamedColor::Foreground
                | NamedColor::Background
                | NamedColor::Cursor => {
                    let code = if is_bg { 49 } else { 39 };
                    out.push_str(&format!("\x1b[{}m", code));
                },
                // Dim colors — map to their non-dim counterparts for v1.
                NamedColor::DimBlack => emit_named_color(out, 0, is_bg, false),
                NamedColor::DimRed => emit_named_color(out, 1, is_bg, false),
                NamedColor::DimGreen => emit_named_color(out, 2, is_bg, false),
                NamedColor::DimYellow => emit_named_color(out, 3, is_bg, false),
                NamedColor::DimBlue => emit_named_color(out, 4, is_bg, false),
                NamedColor::DimMagenta => emit_named_color(out, 5, is_bg, false),
                NamedColor::DimCyan => emit_named_color(out, 6, is_bg, false),
                NamedColor::DimWhite => emit_named_color(out, 7, is_bg, false),
                NamedColor::DimForeground => {
                    let code = if is_bg { 49 } else { 39 };
                    out.push_str(&format!("\x1b[{}m", code));
                },
            }
        },
        Color::Spec(rgb) => {
            // 24-bit (true color) SGR.
            let prefix = if is_bg { 48 } else { 38 };
            out.push_str(&format!("\x1b[{};2;{};{};{}m", prefix, rgb.r, rgb.g, rgb.b));
        },
        Color::Indexed(idx) => {
            // 256-color palette SGR.
            let prefix = if is_bg { 48 } else { 38 };
            out.push_str(&format!("\x1b[{};5;{}m", prefix, idx));
        },
    }
}

/// Emit a named ANSI color SGR code.
///
/// `idx` is 0-7 (the xterm standard palette index).
/// `bright` selects the 90-97 / 100-107 range instead of 30-37 / 40-47.
#[inline]
fn emit_named_color(out: &mut String, idx: u8, is_bg: bool, bright: bool) {
    let base: u8 = match (is_bg, bright) {
        (false, false) => 30,
        (false, true) => 90,
        (true, false) => 40,
        (true, true) => 100,
    };
    out.push_str(&format!("\x1b[{}m", base + idx));
}
