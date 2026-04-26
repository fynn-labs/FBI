//! `CheckpointStore` — periodic snapshots of `ModeState` for efficient
//! seek-to-offset queries via `Parser::snapshot_at(offset)`.
//!
//! # Offset semantics
//!
//! Throughout this module, "the mode state AT byte offset X" means:
//! _the modes that were active BEFORE byte X was processed_ — equivalently,
//! _after all bytes with index 0..X-1 have been processed_.
//!
//! This is the definition that matters for the HTTP Range API: a client
//! requesting `bytes=X-Y` wants the mode state that was in effect at the
//! start of that range, i.e., after the first X bytes of the transcript have
//! been applied.
//!
//! # Checkpoint semantics
//!
//! A checkpoint stored at key `N` records "the mode state after processing
//! all bytes with index 0..N".  Equivalently: the state that was active at
//! the *start of* byte N.
//!
//! Checkpoint at key 0 always exists and holds `ModeState::default()` —
//! the power-on state before any bytes have been seen.
//!
//! # Replay
//!
//! To query the mode state at arbitrary offset Q:
//!   1. Find the latest checkpoint C ≤ Q in `snapshots`.
//!   2. Seed a fresh `ModeScanner` with C's mode state.
//!   3. Feed it bytes `[C..Q)` from `recent_bytes`.
//!   4. Return the scanner's emitted ANSI.
//!
//! # Memory model
//!
//! `recent_bytes` covers `[recent_start_offset, bytes_total())`.
//! `recent_start_offset` is set to the PENULTIMATE checkpoint's offset when
//! a new checkpoint is taken.  This guarantees that:
//!
//! - Any `locate(Q)` where Q ≥ `recent_start_offset` can find a checkpoint
//!   inside the window and replay the necessary bytes.
//! - `recent_bytes` is bounded to at most ~2 × CHECKPOINT_INTERVAL + one
//!   chunk's worth of bytes.
//!
//! The BTreeMap of snapshots is bounded to O(total_bytes / INTERVAL) entries
//! (one per 256 KB), which is negligible.
//!
//! # Checkpoint frequency
//!
//! One checkpoint per `record()` call when a 256 KB boundary has been
//! crossed.  For typical PTY chunks (≤16 KB) this happens roughly every
//! 16 calls.  For very large single chunks the checkpoint is taken at the
//! end of the chunk; replay for queries within that chunk requires reading
//! the whole chunk, but PTY chunks are small in practice.

use std::collections::BTreeMap;

use crate::modes::ModeState;

/// How often (in bytes of transcript) to take a checkpoint.
pub const CHECKPOINT_INTERVAL: u64 = 256 * 1024; // 256 KB

/// Stores periodic `ModeState` snapshots indexed by byte offset, plus a
/// rolling window of raw bytes so that mode state at any offset can be
/// reconstructed by replaying a bounded slice.
pub struct CheckpointStore {
    /// Checkpoints keyed by byte offset.  Key N → "mode state after
    /// processing all bytes 0..N" (state active *at* byte N).
    ///
    /// Key 0 is always present on construction: `ModeState::default()`.
    ///
    /// `BTreeMap` gives O(log n) range queries for the latest checkpoint ≤ Q.
    snapshots: BTreeMap<u64, ModeState>,

    /// Rolling window of raw transcript bytes covering
    /// `[recent_start_offset, bytes_total())`.
    ///
    /// Kept so that replay can reconstruct exact mode state between any two
    /// consecutive checkpoints, even after newer checkpoints have been added.
    recent_bytes: Vec<u8>,

    /// The byte offset at which `recent_bytes[0]` sits in the transcript.
    ///
    /// Equals the offset of the PENULTIMATE (second-to-last) checkpoint so
    /// that queries straddling the last two checkpoints always have the
    /// bytes they need.
    recent_start_offset: u64,
}

impl CheckpointStore {
    /// Construct a new store, pre-seeded with the offset-0 default checkpoint.
    pub fn new() -> Self {
        let mut snapshots = BTreeMap::new();
        // Checkpoint at 0: power-on / default mode state.
        snapshots.insert(0, ModeState::default());
        CheckpointStore {
            snapshots,
            recent_bytes: Vec::new(),
            recent_start_offset: 0,
        }
    }

    /// Record a chunk of bytes that was processed by the parser.
    ///
    /// # Parameters
    ///
    /// - `bytes`: the raw chunk that was just processed.
    /// - `offset_before_chunk`: value of `bytes_fed` *before* this chunk
    ///   (byte index of `bytes[0]` in the transcript).
    /// - `modes_after_chunk`: `ModeState` *after* this chunk was fully
    ///   processed by the mode scanner.
    ///
    /// # Checkpoint logic
    ///
    /// Append `bytes` to `recent_bytes`.  If the total span has crossed the
    /// next 256 KB boundary since the last checkpoint, store a new checkpoint
    /// at `offset_after_chunk` with `modes_after_chunk`.
    ///
    /// When a new checkpoint `new_cp` is stored, advance `recent_start_offset`
    /// to the PENULTIMATE checkpoint's offset (the one just before `new_cp`
    /// in the BTreeMap) and trim `recent_bytes` accordingly.  This retains
    /// at most two checkpoint intervals' worth of bytes.
    pub fn record(
        &mut self,
        bytes: &[u8],
        offset_before_chunk: u64,
        modes_after_chunk: &ModeState,
    ) {
        if bytes.is_empty() {
            return;
        }

        let offset_after_chunk = offset_before_chunk + bytes.len() as u64;

        // Append bytes to the rolling window.
        self.recent_bytes.extend_from_slice(bytes);

        // Find the last checkpoint offset currently in the map (before
        // inserting the potential new one).
        let last_cp_offset = self
            .snapshots
            .keys()
            .next_back()
            .copied()
            .unwrap_or(0);

        // Has the total byte count crossed the next 256 KB boundary since
        // the LAST checkpoint?
        let next_boundary =
            ((last_cp_offset / CHECKPOINT_INTERVAL) + 1) * CHECKPOINT_INTERVAL;

        if offset_after_chunk >= next_boundary {
            // Store checkpoint at end of this chunk.
            self.snapshots.insert(offset_after_chunk, modes_after_chunk.clone());

            // Advance recent_start_offset to the PENULTIMATE checkpoint
            // (the one just before the new one) so that recent_bytes retains
            // enough history for replay across the last two checkpoints.
            //
            // Find the second-to-last checkpoint in the map (i.e., the one
            // just before offset_after_chunk).
            let penultimate_offset = self
                .snapshots
                .range(..offset_after_chunk)
                .next_back()
                .map(|(&k, _)| k)
                .unwrap_or(0);

            if penultimate_offset > self.recent_start_offset {
                // Trim recent_bytes to start at penultimate_offset.
                let trim = (penultimate_offset - self.recent_start_offset) as usize;
                if trim > 0 && trim <= self.recent_bytes.len() {
                    self.recent_bytes.drain(..trim);
                } else if trim > self.recent_bytes.len() {
                    // This shouldn't happen (penultimate is within the window)
                    // but be safe.
                    self.recent_bytes.clear();
                }
                self.recent_start_offset = penultimate_offset;
            }
            // If penultimate_offset <= recent_start_offset, no trimming needed.
        }
    }

    /// Find the latest checkpoint at or before `offset` and return:
    ///   - `cp_offset`: the checkpoint's byte offset,
    ///   - `cp_modes`: the mode state at that checkpoint,
    ///   - `replay_bytes`: the slice of `recent_bytes` covering
    ///     `[cp_offset, offset)` for the caller to feed through a fresh
    ///     `ModeScanner`.
    ///
    /// Returns `None` only if there is no checkpoint at or before `offset`
    /// (impossible given the seed at key 0).
    ///
    /// # Invariant for callers
    ///
    /// The returned `replay_bytes` covers exactly `[cp_offset, min(offset,
    /// bytes_total()))`.  If `offset >= cp_offset + replay_bytes.len()`, the
    /// caller should feed all of `replay_bytes` (the slice already ends at
    /// `offset`).
    pub fn locate(&self, offset: u64) -> Option<(u64, &ModeState, &[u8])> {
        // Find the latest checkpoint key ≤ offset.
        let (&cp_offset, cp_modes) = self.snapshots.range(..=offset).next_back()?;

        // Compute the replay slice from recent_bytes.
        // recent_bytes covers [recent_start_offset, recent_start_offset + recent_bytes.len()).
        //
        // The replay slice is bytes[cp_offset, offset).
        // Map to recent_bytes indices:
        //   rel_cp_start = cp_offset - recent_start_offset
        //   rel_end      = offset    - recent_start_offset

        let window_end = self.recent_start_offset + self.recent_bytes.len() as u64;

        // If cp_offset is before the window start, we don't have replay bytes
        // from cp_offset.  Find the next available start.
        let effective_cp = cp_offset.max(self.recent_start_offset);

        if effective_cp > offset {
            // cp_offset is beyond offset (should not happen given range query).
            return Some((cp_offset, cp_modes, &[]));
        }

        if effective_cp < self.recent_start_offset || effective_cp > window_end {
            // All bytes in the relevant range have been evicted.
            return Some((cp_offset, cp_modes, &[]));
        }

        let rel_start = (effective_cp - self.recent_start_offset) as usize;
        let rel_end = if offset >= self.recent_start_offset {
            ((offset - self.recent_start_offset) as usize).min(self.recent_bytes.len())
        } else {
            0
        };
        let rel_end = rel_end.max(rel_start);

        Some((cp_offset, cp_modes, &self.recent_bytes[rel_start..rel_end]))
    }

    /// Returns the total byte span covered: `recent_start_offset + recent_bytes.len()`.
    pub fn bytes_total(&self) -> u64 {
        self.recent_start_offset + self.recent_bytes.len() as u64
    }
}

impl Default for CheckpointStore {
    fn default() -> Self {
        Self::new()
    }
}
