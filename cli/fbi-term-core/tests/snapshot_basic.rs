use fbi_term_core::Parser;

#[test]
fn snapshot_after_simple_text_contains_text() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello world");
    let snap = p.snapshot();
    // Replay snapshot through a fresh parser; verify the cells.
    let mut p2 = Parser::new(80, 24);
    p2.feed(snap.ansi.as_bytes());
    let row0 = p2._test_row_string(0);
    assert!(row0.starts_with("hello world"), "got: {:?}", row0);
}

#[test]
fn snapshot_dims_match_parser_dims() {
    let p = Parser::new(120, 40);
    let snap = p.snapshot();
    assert_eq!(snap.cols, 120);
    assert_eq!(snap.rows, 40);
}

#[test]
fn snapshot_byte_offset_matches_bytes_fed() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello");
    let snap = p.snapshot();
    assert_eq!(snap.byte_offset, 5);
}

#[test]
fn snapshot_preserves_cursor_position() {
    let mut p = Parser::new(80, 24);
    // Move cursor to row 5, col 10 (1-indexed in CSI).
    p.feed(b"\x1b[5;10H");
    let snap = p.snapshot();
    let mut p2 = Parser::new(80, 24);
    p2.feed(snap.ansi.as_bytes());
    let (row, col) = p2._test_cursor();
    // 0-indexed in alacritty's API.
    assert_eq!((row, col), (4, 9), "snapshot lost cursor position");
}
