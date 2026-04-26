//! fbi-term-core
//!
//! Server-side virtual terminal for FBI runs. Consumes raw PTY bytes,
//! maintains a cell-accurate grid via `alacritty_terminal`, and
//! produces ANSI snapshots that the FBI server sends to xterm.js
//! clients on connect / reconnect / focus change.
//!
//! The crate intentionally has no Elixir or Rustler dependencies — it
//! is pure Rust so it can be unit-tested in isolation. The Rustler NIF
//! wrapper at `server-elixir/native/fbi_term/` re-exports this crate
//! through the BEAM.
//!
//! Public API: see `Parser`, `Snapshot`, `ModePrefix`. They are stubs
//! at this point; subsequent commits flesh them out.

mod parser;
pub use parser::Parser;

/// Result of `Parser::snapshot()`. The `ansi` field is a complete
/// replay of mode state + grid contents + final cursor position;
/// writing it into a fresh xterm.js terminal at the same dims
/// reproduces the source grid.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub ansi: String,
    pub cols: u16,
    pub rows: u16,
    pub byte_offset: u64,
}

/// Result of `Parser::snapshot_at(offset)`. Modes-only — no cell
/// content. Prepended by the HTTP transcript Range API to chunk
/// responses so the client's xterm.js parser starts the chunk in
/// the right buffer / scroll region / mode state.
#[derive(Debug, Clone)]
pub struct ModePrefix {
    pub ansi: String,
}
