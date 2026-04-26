//! Integration tests for `CheckpointStore` and `Parser::snapshot_at`.

use fbi_term_core::Parser;

/// Feeding a mode-changing sequence, then requesting `snapshot_at` the offset
/// immediately after that sequence, should return a prefix that reproduces
/// the mode that was set.
#[test]
fn snapshot_at_returns_modes_at_offset() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[?1049h"); // offset 0..7: enter alt screen
    let after_alt = p.bytes_fed(); // 7
    p.feed(b"some text\r\n"); // offset 7..18
    p.feed(b"\x1b[?1049l"); // offset 18..25: exit alt screen

    // Asking for the state AT offset `after_alt` (= 7) means "modes after
    // the first 7 bytes have been processed" — alt screen should be on.
    let prefix = p.snapshot_at(after_alt);
    let mut p2 = Parser::new(80, 24);
    p2.feed(prefix.ansi.as_bytes());
    assert!(
        p2._test_in_alt_screen(),
        "snapshot_at({}) did not preserve alt screen state (ansi={:?})",
        after_alt,
        prefix.ansi,
    );
}

/// Requesting `snapshot_at(0)` should return default (power-on) modes because
/// no bytes have been processed yet at that point.
#[test]
fn snapshot_at_at_zero_returns_default_modes() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[?1049h");
    p.feed(b"\x1b[5;20r");

    let prefix = p.snapshot_at(0);
    let mut p2 = Parser::new(80, 24);
    p2.feed(prefix.ansi.as_bytes());

    // At offset 0, no bytes have been processed — modes must be default.
    assert!(
        !p2._test_in_alt_screen(),
        "snapshot_at(0) should not report alt screen"
    );
    assert_eq!(
        p2._test_scroll_region(),
        (None, None),
        "snapshot_at(0) should report default (full-screen) scroll region"
    );
}

/// After setting a DECSTBM scroll region, `snapshot_at` at that offset should
/// reconstruct the region correctly.
#[test]
fn snapshot_at_after_decstbm_returns_region() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[3;15r"); // set scroll region rows 3-15
    let after_stbm = p.bytes_fed();
    p.feed(b"\x1b[r"); // reset region to full screen

    // snapshot_at(after_stbm) should show region 3–15.
    let prefix = p.snapshot_at(after_stbm);
    let mut p2 = Parser::new(80, 24);
    p2.feed(prefix.ansi.as_bytes());
    assert_eq!(
        p2._test_scroll_region(),
        (Some(3), Some(15)),
        "snapshot_at({}) should restore scroll region 3-15 (ansi={:?})",
        after_stbm,
        prefix.ansi,
    );
}

/// Feed more than CHECKPOINT_INTERVAL bytes so that at least one checkpoint is
/// written, then verify that `snapshot_at` still correctly returns the mode
/// state from before the padding.
#[test]
fn snapshot_at_with_large_history_uses_checkpoints() {
    use fbi_term_core::CHECKPOINT_INTERVAL;

    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[?1049h"); // enter alt screen
    let after_alt = p.bytes_fed(); // small offset

    // Feed > CHECKPOINT_INTERVAL worth of harmless bytes (no mode changes)
    // to force the store to write a checkpoint.
    let pad = vec![b'x'; (CHECKPOINT_INTERVAL + 50_000) as usize];
    p.feed(&pad);

    // Despite the large gap, snapshot_at(after_alt) must still know that
    // alt screen was active at that offset.
    let prefix = p.snapshot_at(after_alt);
    let mut p2 = Parser::new(80, 24);
    p2.feed(prefix.ansi.as_bytes());
    assert!(
        p2._test_in_alt_screen(),
        "snapshot_at({}) lost alt-screen state across checkpoint boundary (ansi={:?})",
        after_alt,
        prefix.ansi,
    );
}

/// `snapshot_at(bytes_fed())` should match the current mode state — the
/// "snapshot at the very end of what's been processed" edge case.
#[test]
fn snapshot_at_current_offset_matches_current_modes() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[?1049h");
    p.feed(b"\x1b[3;10r");

    let current = p.bytes_fed();
    let prefix = p.snapshot_at(current);
    let mut p2 = Parser::new(80, 24);
    p2.feed(prefix.ansi.as_bytes());

    assert!(p2._test_in_alt_screen(), "snapshot_at(current) should report alt screen");
    assert_eq!(
        p2._test_scroll_region(),
        (Some(3), Some(10)),
        "snapshot_at(current) should report scroll region 3-10"
    );
}
