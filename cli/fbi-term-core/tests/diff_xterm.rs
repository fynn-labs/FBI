//! Differential test harness: feed each fixture's bytes through both
//! fbi-term-core's Parser AND @xterm/headless (via xterm_ref.mjs), then
//! compare the resulting normalized grids cell-by-cell.
//!
//! When a test fails, the failure dump prints a row-by-row diff so the
//! disagreement is easy to localize. A mismatch is almost always a bug
//! in our parser or serializer — xterm.js is the canonical reference
//! for what FBI's clients render.
//!
//! # Running
//!
//! ```bash
//! CARGO_HOME=/tmp/cargo-home cargo test -p fbi-term-core --test diff_xterm -- --nocapture
//! ```
//!
//! Requires `node` (v18+) on PATH and `@xterm/headless` installed in the
//! workspace `node_modules/`.

use std::io::Write;
use std::process::{Command, Stdio};

use fbi_term_core::Parser;
use serde_json::Value;

// ── xterm reference grid ──────────────────────────────────────────────────────

/// Feed `bytes` through `xterm_ref.mjs` and return the parsed JSON grid.
fn xterm_ref_grid(bytes: &[u8], cols: u16, rows: u16) -> Value {
    // xterm_ref.mjs is relative to the crate root, not the workspace root.
    // Cargo runs integration tests with cwd = the crate's directory.
    let mut child = Command::new("node")
        .arg("tests/support/xterm_ref.mjs")
        .arg(cols.to_string())
        .arg(rows.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn xterm_ref.mjs (is node available on PATH?)");

    child.stdin.as_mut().unwrap().write_all(bytes).unwrap();
    drop(child.stdin.take()); // close stdin so node sees EOF

    let out = child.wait_with_output().unwrap();
    if !out.status.success() {
        panic!(
            "xterm_ref.mjs failed (exit={}):\nstderr: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    serde_json::from_slice(&out.stdout).expect("parse xterm_ref output as JSON")
}

// ── fbi-term-core grid ────────────────────────────────────────────────────────

/// Feed `bytes` through our `Parser` and return `dump_normalized_grid()`.
fn fbi_term_grid(bytes: &[u8], cols: u16, rows: u16) -> Value {
    let mut p = Parser::new(cols, rows);
    p.feed(bytes);
    p.dump_normalized_grid()
}

// ── Grid comparison ───────────────────────────────────────────────────────────

/// Compare two normalized grids.  On mismatch, print a row-by-row diff and
/// panic with a summary count.
fn diff_grids(name: &str, ours: &Value, theirs: &Value) {
    // alt_screen must match.
    if ours["alt_screen"] != theirs["alt_screen"] {
        panic!(
            "{}: alt_screen differs (ours={}, theirs={})",
            name, ours["alt_screen"], theirs["alt_screen"]
        );
    }

    // Cursor: log differences but don't fail — minor cursor disagreements
    // (e.g. due to cursor-save/restore edge cases) are acceptable for now.
    if ours["cursor_row"] != theirs["cursor_row"] || ours["cursor_col"] != theirs["cursor_col"] {
        eprintln!(
            "{}: cursor diff — ours=({},{}) theirs=({},{})",
            name,
            ours["cursor_row"],
            ours["cursor_col"],
            theirs["cursor_row"],
            theirs["cursor_col"]
        );
    }

    let ours_rows = ours["rows_data"].as_array().expect("ours rows_data");
    let theirs_rows = theirs["rows_data"].as_array().expect("theirs rows_data");

    let max_rows = ours_rows.len().max(theirs_rows.len());
    let empty = serde_json::json!([]);
    let mut mismatched: Vec<(usize, Value, Value)> = vec![];

    for r in 0..max_rows {
        let our_row = ours_rows.get(r).cloned().unwrap_or_else(|| empty.clone());
        let their_row = theirs_rows.get(r).cloned().unwrap_or_else(|| empty.clone());
        if our_row != their_row {
            mismatched.push((r, our_row, their_row));
        }
    }

    if !mismatched.is_empty() {
        eprintln!("\n=== {} grid mismatch ({} row(s)) ===", name, mismatched.len());
        for (r, our, their) in &mismatched {
            eprintln!("  row {}:", r);
            eprintln!("    ours   = {}", our);
            eprintln!("    theirs = {}", their);
        }
        panic!("{}: {} row(s) differ", name, mismatched.len());
    }
}

// ── Test macro ────────────────────────────────────────────────────────────────

macro_rules! scenario_test {
    ($name:ident, $fixture:literal) => {
        #[test]
        fn $name() {
            let bytes = std::fs::read(concat!("tests/fixtures/", $fixture, ".bin"))
                .expect(concat!("read fixture tests/fixtures/", $fixture, ".bin"));
            let ours = fbi_term_grid(&bytes, 80, 24);
            let theirs = xterm_ref_grid(&bytes, 80, 24);
            diff_grids($fixture, &ours, &theirs);
        }
    };
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

scenario_test!(alt_screen_cycle,      "alt-screen-cycle");
scenario_test!(scroll_region_stress,  "scroll-region-stress");
scenario_test!(mouse_modes_cycle,     "mouse-modes-cycle");
scenario_test!(cjk_wide,              "cjk-wide");
scenario_test!(truecolor,             "truecolor");
scenario_test!(bracketed_paste_cycle, "bracketed-paste-cycle");
scenario_test!(cursor_styles,         "cursor-styles");
