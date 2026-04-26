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

        Self { term, processor, cols, rows, bytes_fed: 0 }
    }

    /// Feed raw PTY bytes into the terminal. May be called repeatedly;
    /// the processor state is preserved across calls (partial escape
    /// sequences are correctly stitched together).
    pub fn feed(&mut self, bytes: &[u8]) {
        // `Processor::advance` is the hot path: it calls through to
        // `Term`'s `Handler` impl for each decoded ANSI action (print,
        // cursor move, color change, mode toggle, …).
        self.processor.advance(&mut self.term, bytes);
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
}
