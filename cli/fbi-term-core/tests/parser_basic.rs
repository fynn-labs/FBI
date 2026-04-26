use fbi_term_core::Parser;

#[test]
fn parser_dims_default_to_constructor() {
    let p = Parser::new(120, 40);
    assert_eq!(p.cols(), 120);
    assert_eq!(p.rows(), 40);
}

#[test]
fn parser_accepts_feed_without_error() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello\r\nworld\r\n");
    // No panic, no return value to check yet.
}

#[test]
fn parser_reports_bytes_fed() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello");
    p.feed(b" world");
    assert_eq!(p.bytes_fed(), 11);
}
