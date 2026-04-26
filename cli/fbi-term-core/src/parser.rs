//! `Parser` — the central type of `fbi-term-core`.
//!
//! Each FBI run owns one `Parser`. Raw PTY bytes flow in through
//! `feed`; the internal `alacritty_terminal::Term` grid is updated in
//! place. Later tasks will add `snapshot()` (emit the full ANSI replay
//! string) and `resize()`.
//!
//! # Dependency boundary
//!
//! `alacritty_terminal` and `vte` are deliberately contained here.
//! Nothing above this file should need to import either crate. The
//! plumbing rationale for each layer is explained in-line below.

// ── alacritty_terminal API summary (verified against v0.26.0) ────────────────
//
//   Term::new(config: term::Config, dimensions: &D, event_proxy: T) -> Term<T>
//     where D: grid::Dimensions (provides columns() + screen_lines())
//           T: event::EventListener (receives bell/title-change/etc. events)
//
//   `term::Config` is a plain struct with a `Default` impl. Fields include
//   `scrolling_history`, `semantic_escape_chars`, and `kitty_keyboard`. We
//   use `Config::default()` (10 000 lines of scrollback, no kitty protocol).
//
//   There is *no* public `TermSize` outside the `term::test` sub-module.
//   The crate does export `term::test::TermSize` as a public type, but using a
//   test-helper type in production code is awkward. Instead we implement the
//   `grid::Dimensions` trait on our own private `TermSize` struct — three
//   methods, ~10 lines.
//
//   `Term<T>` itself implements `vte::ansi::Handler` (the trait that receives
//   decoded ANSI actions). To feed raw bytes we need a `vte::ansi::Processor`
//   which drives a `vte::Parser` state machine and calls `Handler` methods on
//   `Term`.
//
//     vte::ansi::Processor::advance(&mut self, handler: &mut H, bytes: &[u8])
//       where H: vte::ansi::Handler
//
//   The default type parameter `Processor<StdSyncHandler>` handles
//   synchronized-update mode (DEC private mode 2026) automatically, which is
//   present in modern terminal output. `Processor::new()` / `Default` is all
//   we need.
//
// ── EventListener ────────────────────────────────────────────────────────────
//
//   alacritty fires events (bell, title, clipboard, PTY-write) through the
//   EventListener trait. The server-side parser has no bell hardware, no
//   clipboard, and no PTY write-back path — so we discard them with a no-op
//   listener.
//
//   alacritty_terminal already ships a `VoidListener` in `event.rs` that
//   implements `EventListener` with an empty body. We use that.
// ─────────────────────────────────────────────────────────────────────────────

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::Config;
use vte::ansi::Processor;

use crate::modes::ModeScanner;

// ── Private size helper ───────────────────────────────────────────────────────
//
// `alacritty_terminal::grid::Dimensions` is a three-method trait. The only
// public implementor in non-test code is `Grid<G>` itself; the convenient
// `term::test::TermSize` lives behind a `pub mod test` that is clearly
// intended for use in tests only.
//
// We define our own minimal `TermSize` here so production code doesn't depend
// on a test helper. If alacritty ever promotes a public `TermSize` we can
// remove this.
struct TermSize {
    cols: usize,
    rows: usize,
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        // For a freshly constructed terminal the history is empty, so
        // total_lines == screen_lines. This value is used by the Grid
        // constructor to set the initial scrollback capacity.
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

// ── Parser ────────────────────────────────────────────────────────────────────

/// Server-side virtual terminal handle. One per FBI run.
///
/// Wraps `alacritty_terminal::Term` (the grid + mode state) and a
/// `vte::ansi::Processor` (the byte-stream decoder). Hides alacritty's
/// type plumbing so callers see a clean `feed`/`snapshot`/`resize`
/// surface that maps directly onto the Rustler NIF.
pub struct Parser {
    /// Grid + mode state. Parameterised over the event listener type.
    /// `VoidListener` discards all side-channel events (bell, title, etc.)
    /// because the server has no use for them at this layer.
    term: Term<VoidListener>,

    /// VTE state machine that decodes raw bytes into ANSI actions and
    /// forwards them to `term` (which implements `vte::ansi::Handler`).
    ///
    /// The `StdSyncHandler` default type parameter handles DEC private
    /// mode 2026 (synchronized updates) transparently — modern TUIs use
    /// this, so we must support it.
    processor: Processor,

    /// Logical column count stored separately so `cols()` is O(1) without
    /// borrowing `term`. Kept in sync with `term`'s dimensions.
    cols: u16,

    /// Logical row count, same rationale as `cols`.
    rows: u16,

    /// Total bytes passed to `feed` across all calls. Monotonically
    /// increasing; used by the checkpoint store (Task 1.5) to associate
    /// snapshots with byte offsets into the run transcript.
    bytes_fed: u64,

    /// Parallel DEC private mode + DECSTBM scroll-region tracker.
    ///
    /// `alacritty_terminal::Term` tracks modes internally but offers no API
    /// to re-emit them as ANSI.  We run `ModeScanner` over the same byte
    /// stream alongside the alacritty processor so that `snapshot()` can
    /// prepend a mode-replay prefix.  See `crate::modes` for the full
    /// rationale.
    pub(crate) mode_scanner: ModeScanner,
}

impl Parser {
    /// Construct a new parser for a terminal with the given dimensions.
    ///
    /// `cols` and `rows` are in character cells. Typical values: 80×24
    /// (default xterm), 120×40 (widescreen), etc.
    pub fn new(cols: u16, rows: u16) -> Self {
        // `Config::default()` sets 10 000-line scrollback history,
        // the standard semantic escape characters, and no kitty keyboard
        // protocol — all sensible defaults for a server-side recorder.
        let config = Config::default();

        let size = TermSize { cols: cols as usize, rows: rows as usize };

        // `VoidListener` is alacritty's own no-op implementation of
        // `EventListener`. It lives in `alacritty_terminal::event`.
        let term = Term::new(config, &size, VoidListener);

        // `Processor::new()` == `Processor::<StdSyncHandler>::new()`.
        // The StdSyncHandler uses `std::time::Instant` for the
        // synchronized-update timeout; no setup required.
        let processor = Processor::new();

        Self { term, processor, cols, rows, bytes_fed: 0, mode_scanner: ModeScanner::new() }
    }

    /// Feed raw PTY bytes into the terminal. May be called repeatedly;
    /// the processor state is preserved across calls (partial escape
    /// sequences are correctly stitched together).
    pub fn feed(&mut self, bytes: &[u8]) {
        // Feed the alacritty processor (handles cell writes, cursor moves,
        // color changes, mode toggles that affect the grid, etc.).
        self.processor.advance(&mut self.term, bytes);

        // Feed the same bytes into the mode scanner in parallel.  The mode
        // scanner only cares about DEC private mode h/l and DECSTBM; it
        // ignores everything else.  Running it after alacritty means both
        // parsers always see the same bytes in the same order.
        self.mode_scanner.feed(bytes);

        self.bytes_fed += bytes.len() as u64;
    }

    /// Returns the column count this parser was constructed with.
    #[inline]
    pub fn cols(&self) -> u16 {
        self.cols
    }

    /// Returns the row count this parser was constructed with.
    #[inline]
    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Returns the total number of bytes fed to this parser since construction.
    ///
    /// This is a raw byte count — multibyte UTF-8 sequences count as multiple
    /// bytes, and ANSI escape sequences are included. The value is used as a
    /// byte offset into the run transcript for checkpoint correlation.
    #[inline]
    pub fn bytes_fed(&self) -> u64 {
        self.bytes_fed
    }

    // ── Snapshot ──────────────────────────────────────────────────────────────

    /// Serialize the current mode state + grid + cursor position to an ANSI
    /// replay string.
    ///
    /// Writing the returned `Snapshot::ansi` into a fresh xterm.js terminal
    /// at the same dimensions (`cols` × `rows`) reproduces:
    ///   - the correct buffer (alt vs main), scroll region, DECTCEM, DECAWM,
    ///     and other DEC private modes (via the leading mode prefix)
    ///   - every cell character with full SGR attributes
    ///   - the final cursor position
    pub fn snapshot(&self) -> crate::Snapshot {
        // Build the mode prefix first (buffer, scroll region, cursor
        // visibility, mouse modes, etc.).  This must come before the grid
        // content so that the replay terminal is in the right buffer before
        // any characters land.
        let mode_prefix = self.mode_scanner.emit(self.rows);

        // Serialize the grid content + final CUP.
        let grid_ansi = crate::serialize::serialize_grid(&self.term);

        let ansi = format!("{}{}", mode_prefix, grid_ansi);

        crate::Snapshot {
            ansi,
            cols: self.cols,
            rows: self.rows,
            byte_offset: self.bytes_fed,
        }
    }

    // ── Mode scanner test helpers ─────────────────────────────────────────────
    //
    // All `pub` (not `cfg(test)`) so integration tests in `tests/` can call
    // them.  The leading underscore signals "test helper, not production API".

    /// Returns `true` if the terminal is currently in the alternate screen
    /// buffer (any of `?47`, `?1047`, `?1049` was last set).
    pub fn _test_in_alt_screen(&self) -> bool {
        self.mode_scanner.modes.alt_screen
    }

    /// Returns the current DECSTBM scroll region as `(top, bottom)`.
    /// `None` means the scroll region is at its default (full screen).
    pub fn _test_scroll_region(&self) -> (Option<u16>, Option<u16>) {
        (self.mode_scanner.modes.stbm_top, self.mode_scanner.modes.stbm_bottom)
    }

    /// Returns `true` if DECTCEM (?25) is set (cursor is visible).
    pub fn _test_cursor_visible(&self) -> bool {
        self.mode_scanner.modes.cursor_visible
    }

    /// Returns `(mouse_mode, mouse_ext)` — the active mouse-tracking mode
    /// and encoding extension.  Both are 0 when disabled.
    pub fn _test_mouse_modes(&self) -> (u16, u16) {
        (self.mode_scanner.modes.mouse_mode, self.mode_scanner.modes.mouse_ext)
    }

    /// Returns a reference to the current `ModeState`.
    ///
    /// Useful in tests that need to inspect modes not covered by a dedicated
    /// helper (e.g. `auto_wrap`, `bracketed_paste`, `focus_reporting`).
    pub fn modes(&self) -> &crate::modes::ModeState {
        &self.mode_scanner.modes
    }

    // ── Grid / cursor test helpers ────────────────────────────────────────────
    //
    // These are `#[cfg(test)]` so they compile only in test builds.  The
    // leading underscore signals "test-only helper, not public API".

    /// Read row `row` (0-indexed) as a plain UTF-8 string, stripping all SGR
    /// attributes.  Used by tests that want to inspect grid content without
    /// caring about colors or style.
    ///
    /// The leading underscore signals that this is a test helper not intended
    /// for production use.  It is always compiled (not `#[cfg(test)]`) so that
    /// integration tests in `tests/` can call it too.
    pub fn _test_row_string(&self, row: usize) -> String {
        use alacritty_terminal::grid::Dimensions;
        use alacritty_terminal::index::{Column, Line};
        use alacritty_terminal::term::cell::Flags;

        let grid = self.term.grid();
        let num_cols = grid.columns();
        let line = Line(row as i32);
        let row_ref = &grid[line];

        let mut s = String::with_capacity(num_cols);
        for col in 0..num_cols {
            let cell = &row_ref[Column(col)];
            // Skip wide-char spacers — the preceding WIDE_CHAR cell already
            // emitted the character.
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            s.push(cell.c);
            // Include zero-width combining characters.
            if let Some(zw) = cell.zerowidth() {
                for &ch in zw {
                    s.push(ch);
                }
            }
        }

        // Trim trailing spaces so callers can use `starts_with` / `ends_with`
        // assertions without worrying about padding to the terminal width.
        s.trim_end().to_owned()
    }

    /// Read the current cursor position as `(row, col)`, both 0-indexed.
    ///
    /// `row` 0 is the top of the screen; `col` 0 is the leftmost column.
    ///
    /// Same "always compiled, test helper" convention as `_test_row_string`.
    pub fn _test_cursor(&self) -> (usize, usize) {
        let point = self.term.grid().cursor.point;
        // `point.line` is a `Line(i32)` — 0 = top of viewport.
        // `point.column` is a `Column(usize)`.
        let row = point.line.0 as usize;
        let col = point.column.0;
        (row, col)
    }
}
