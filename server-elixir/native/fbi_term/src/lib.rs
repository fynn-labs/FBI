//! Rustler NIF wrapper exposing fbi-term-core to the BEAM.
//!
//! ## Resource model
//!
//! Each FBI run holds one parser handle. On the Rust side that's a
//! `ResourceArc<Mutex<Parser>>`; on the Elixir side it's an opaque
//! reference. The handle is reclaimed by BEAM GC when the holding
//! process terminates and the reference becomes unreachable.
//!
//! - `ResourceArc`: BEAM-managed reference counting. The destructor
//!   runs when the last reference drops.
//! - `Mutex<Parser>`: NIFs can theoretically be invoked from multiple
//!   BEAM scheduler threads, even on the same handle. We only call
//!   from one process (the run's GenServer) in practice, but the
//!   Mutex makes the contract safe regardless.
//!
//! ## Panic safety
//!
//! `panic = "abort"` in release. Every NIF wraps its body in
//! `catch_unwind` so a panic returns `{:error, :nif_panic}` instead
//! of crashing the BEAM node. Panics are P0 bugs to investigate —
//! they should never happen for input the existing pipeline accepts.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

use fbi_term_core::Parser;
use rustler::{Atom, Binary, Env, NifResult, NifStruct, Resource, ResourceArc, Term};

mod atoms {
    rustler::atoms! {
        ok,
        nif_panic,
    }
}

/// The parser resource. Holds the parser behind a Mutex so concurrent
/// NIF calls on the same handle (rare but possible) serialize correctly.
pub struct ParserResource(pub Mutex<Parser>);

impl Resource for ParserResource {}

#[rustler::nif]
fn new(cols: u16, rows: u16) -> ResourceArc<ParserResource> {
    ResourceArc::new(ParserResource(Mutex::new(Parser::new(cols, rows))))
}

#[rustler::nif(schedule = "DirtyIo")]
fn feed(handle: ResourceArc<ParserResource>, bytes: Binary) -> NifResult<Atom> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut g = handle.0.lock().unwrap();
        g.feed(bytes.as_slice());
    }));
    match result {
        Ok(()) => Ok(atoms::ok()),
        Err(_) => Err(rustler::Error::Term(Box::new(atoms::nif_panic()))),
    }
}

#[derive(NifStruct)]
#[module = "FBI.Terminal.Snapshot"]
struct SnapshotEx {
    ansi: String,
    cols: u16,
    rows: u16,
    byte_offset: u64,
}

#[rustler::nif]
fn snapshot(handle: ResourceArc<ParserResource>) -> NifResult<SnapshotEx> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let g = handle.0.lock().unwrap();
        let s = g.snapshot();
        SnapshotEx {
            ansi: s.ansi,
            cols: s.cols,
            rows: s.rows,
            byte_offset: s.byte_offset,
        }
    }));
    result.map_err(|_| rustler::Error::Term(Box::new(atoms::nif_panic())))
}

#[derive(NifStruct)]
#[module = "FBI.Terminal.ModePrefix"]
struct ModePrefixEx {
    ansi: String,
}

#[rustler::nif]
fn snapshot_at(handle: ResourceArc<ParserResource>, offset: u64) -> NifResult<ModePrefixEx> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let g = handle.0.lock().unwrap();
        let p = g.snapshot_at(offset);
        ModePrefixEx { ansi: p.ansi }
    }));
    result.map_err(|_| rustler::Error::Term(Box::new(atoms::nif_panic())))
}

#[rustler::nif]
fn resize(handle: ResourceArc<ParserResource>, cols: u16, rows: u16) -> NifResult<Atom> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut g = handle.0.lock().unwrap();
        g.resize(cols, rows);
    }));
    result.map(|_| atoms::ok()).map_err(|_| rustler::Error::Term(Box::new(atoms::nif_panic())))
}

fn on_load(env: Env, _: Term) -> bool {
    env.register::<ParserResource>().is_ok()
}

rustler::init!("Elixir.FBI.Terminal", load = on_load);
