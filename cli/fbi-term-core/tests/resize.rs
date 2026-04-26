use fbi_term_core::Parser;

#[test]
fn resize_changes_reported_dims() {
    let mut p = Parser::new(80, 24);
    p.resize(120, 40);
    assert_eq!(p.cols(), 120);
    assert_eq!(p.rows(), 40);
}

#[test]
fn snapshot_after_resize_uses_new_dims() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello");
    p.resize(40, 10);
    let snap = p.snapshot();
    assert_eq!(snap.cols, 40);
    assert_eq!(snap.rows, 10);
}

#[test]
fn resize_to_same_dims_is_noop() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello");
    p.resize(80, 24); // no change
    assert_eq!(p.cols(), 80);
    assert_eq!(p.rows(), 24);
}
