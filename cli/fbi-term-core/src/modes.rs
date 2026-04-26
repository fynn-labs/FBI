//! `ModeScanner` — lightweight DEC private mode + DECSTBM tracker.
//!
//! # Why a separate scanner?
//!
//! `alacritty_terminal::Term` tracks DEC private modes internally but
//! does not expose them in a form we can re-emit as a leading ANSI prefix.
//! Rather than patching alacritty (an upstream dependency we want to keep
//! unmodified) we run our own tiny VT500-series CSI state machine over the
//! same byte stream in parallel.  The algorithm is a direct port of the
//! battle-tested TypeScript `ModeScanner` in
//! `src/server/logs/screen.ts:25-161`; any behavioural differences would
//! be bugs.
//!
//! # CSI parser state machine
//!
//! Three states — `Normal`, `Esc`, `Csi` — implement the Williams VT500
//! subset we care about:
//!
//! ```text
//! Normal  --0x1b--> Esc
//! Esc     --'['---> Csi  (clears csi_private / csi_params)
//! Esc     --else--> Normal
//! Csi     --private-prefix (0x3c..=0x3f, first byte only)--> record it
//! Csi     --digit/;/:--> accumulate csi_params
//! Csi     --final (0x40..=0x7e)--> dispatch(), Normal
//! Csi     --intermediate (0x20..=0x2f)--> ignore, stay in Csi
//! Csi     --anything else--> Normal  (abort)
//! ```

// ── State machine ─────────────────────────────────────────────────────────────

/// Three-state CSI parser state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ScanState {
    Normal,
    Esc,
    Csi,
}

// ── Mode state ────────────────────────────────────────────────────────────────

/// All DEC private modes + DECSTBM scroll region tracked by the scanner.
///
/// Default values match xterm's documented power-on defaults.
#[derive(Debug, Clone)]
pub struct ModeState {
    /// ?7 — DECAWM: characters wrap at right margin (default on).
    pub auto_wrap: bool,

    /// ?25 — DECTCEM: cursor is visible (default on).
    pub cursor_visible: bool,

    /// ?47 / ?1047 / ?1049 — all three control the same flag.
    /// `true` means the terminal is currently in the alternate screen
    /// buffer (default off).
    pub alt_screen: bool,

    /// ?1004 — focus reporting: terminal sends CSI I / CSI O on focus
    /// gain / loss (default off).
    pub focus_reporting: bool,

    /// ?2004 — bracketed paste: wraps paste with `\e[200~` / `\e[201~`
    /// (default off).
    pub bracketed_paste: bool,

    /// ?2031 — in-band resize reporting (default off).
    pub in_band_resize: bool,

    /// Mouse-tracking mode — mutually exclusive (0 = off).
    /// Valid non-zero values: 1000 (X10), 1002 (button), 1003 (any-event).
    pub mouse_mode: u16,

    /// Mouse-encoding extension — mutually exclusive (0 = off).
    /// Valid non-zero values: 1006 (SGR), 1015 (URXVT), 1016 (SGR-pixels).
    pub mouse_ext: u16,

    /// DECSTBM scroll-region top row (1-indexed).
    /// `None` means "full screen / default".
    pub stbm_top: Option<u16>,

    /// DECSTBM scroll-region bottom row (1-indexed).
    /// `None` means "full screen / default".
    pub stbm_bottom: Option<u16>,
}

impl Default for ModeState {
    fn default() -> Self {
        ModeState {
            auto_wrap: true,        // xterm default: on
            cursor_visible: true,   // xterm default: on
            alt_screen: false,
            focus_reporting: false,
            bracketed_paste: false,
            in_band_resize: false,
            mouse_mode: 0,
            mouse_ext: 0,
            stbm_top: None,
            stbm_bottom: None,
        }
    }
}

// ── ModeScanner ───────────────────────────────────────────────────────────────

/// Feeds bytes through a minimal VT500 CSI state machine and records the
/// latest value of each tracked DEC private mode + DECSTBM scroll region.
///
/// The scanner is deliberately independent of `alacritty_terminal` so that
/// `emit()` can produce ANSI that replays the mode state into a fresh
/// terminal — something alacritty's internal state cannot do directly.
pub struct ModeScanner {
    /// Publicly readable mode state.
    pub modes: ModeState,

    /// Current parser state.
    state: ScanState,

    /// Private-prefix character seen at the start of a CSI sequence (e.g.
    /// `'?'` for DEC private modes, `'\0'` for none).
    csi_private: Option<char>,

    /// Accumulated parameter bytes (digits, `;`, `:`).
    csi_params: String,
}

impl ModeScanner {
    /// Construct a new scanner with default (power-on) mode state.
    pub fn new() -> Self {
        ModeScanner {
            modes: ModeState::default(),
            state: ScanState::Normal,
            csi_private: None,
            csi_params: String::new(),
        }
    }

    /// Feed raw bytes into the scanner.  May be called repeatedly; the
    /// state machine survives chunk boundaries (a partial CSI split across
    /// two `feed` calls is correctly completed on the next call).
    pub fn feed(&mut self, data: &[u8]) {
        for &b in data {
            match self.state {
                ScanState::Normal => {
                    if b == 0x1b {
                        self.state = ScanState::Esc;
                    }
                    // All other bytes in Normal state are irrelevant to modes.
                }
                ScanState::Esc => {
                    if b == 0x5b {
                        // `[` — start of a CSI sequence.
                        self.state = ScanState::Csi;
                        self.csi_private = None;
                        self.csi_params.clear();
                    } else {
                        // Non-CSI escape (e.g. ESC 7 = DECSC) — not tracked.
                        self.state = ScanState::Normal;
                    }
                }
                ScanState::Csi => {
                    if self.csi_private.is_none()
                        && self.csi_params.is_empty()
                        && (0x3c..=0x3f).contains(&b)
                    {
                        // Private-prefix byte (`<`, `=`, `>`, `?`).
                        // Only the very first byte in the CSI sequence can be
                        // a private prefix.
                        self.csi_private = Some(b as char);
                    } else if b.is_ascii_digit() || b == b';' || b == b':' {
                        // Parameter byte.
                        self.csi_params.push(b as char);
                    } else if (0x40..=0x7e).contains(&b) {
                        // Final byte — dispatch and return to Normal.
                        let final_char = b as char;
                        self.dispatch(final_char);
                        self.state = ScanState::Normal;
                    } else if (0x20..=0x2f).contains(&b) {
                        // Intermediate byte — ignored, keep accumulating.
                    } else {
                        // Unexpected / control byte — abort CSI sequence.
                        self.state = ScanState::Normal;
                    }
                }
            }
        }
    }

    /// Dispatch a completed CSI sequence (called when the final byte arrives).
    fn dispatch(&mut self, final_byte: char) {
        if self.csi_private == Some('?')
            && (final_byte == 'h' || final_byte == 'l')
        {
            // DEC private mode set (`h`) or clear (`l`).
            let set = final_byte == 'h';
            // Parse semicolon-separated parameter list.
            let params_str = self.csi_params.clone();
            for part in params_str.split(';') {
                if part.is_empty() {
                    continue;
                }
                if let Ok(n) = part.parse::<u16>() {
                    self.apply_dec_mode(n, set);
                }
            }
        } else if self.csi_private.is_none() && final_byte == 'r' {
            // DECSTBM — set or reset scroll region.
            let params_str = self.csi_params.clone();
            let mut parts = params_str.splitn(2, ';');
            let top_str = parts.next().unwrap_or("");
            let bot_str = parts.next().unwrap_or("");
            let top = top_str.parse::<u16>().ok();
            let bot = bot_str.parse::<u16>().ok();
            if let (Some(t), Some(b)) = (top, bot) {
                self.modes.stbm_top = Some(t);
                self.modes.stbm_bottom = Some(b);
            } else {
                // Empty or partial params — reset to full screen.
                self.modes.stbm_top = None;
                self.modes.stbm_bottom = None;
            }
        }
    }

    /// Apply a single DEC private mode number with `set` = true/false.
    fn apply_dec_mode(&mut self, n: u16, set: bool) {
        match n {
            7 => self.modes.auto_wrap = set,
            25 => self.modes.cursor_visible = set,
            // All three alt-screen variants control the same flag.
            47 | 1047 | 1049 => self.modes.alt_screen = set,
            1004 => self.modes.focus_reporting = set,
            2004 => self.modes.bracketed_paste = set,
            2031 => self.modes.in_band_resize = set,
            // Mouse-tracking modes are mutually exclusive.
            // Setting one clears the others implicitly (we store only one
            // value).  Clearing only takes effect if the requested mode
            // matches the currently active mode.
            1000 | 1002 | 1003 => {
                if set {
                    self.modes.mouse_mode = n;
                } else if self.modes.mouse_mode == n {
                    self.modes.mouse_mode = 0;
                }
            }
            // Mouse-encoding extensions are mutually exclusive.
            1006 | 1015 | 1016 => {
                if set {
                    self.modes.mouse_ext = n;
                } else if self.modes.mouse_ext == n {
                    self.modes.mouse_ext = 0;
                }
            }
            _ => { /* not tracked */ }
        }
    }

    /// Emit ANSI that replays the current mode state into a fresh terminal.
    ///
    /// The output prepended to a grid snapshot ensures the client terminal
    /// lands in exactly the same buffer, scroll region, and mode configuration
    /// as the recorded session — regardless of what state the client was left
    /// in from a previous snapshot.
    ///
    /// `rows` is the current terminal height; used to clamp DECSTBM so a
    /// stale scroll region captured at a smaller dimension still resolves to
    /// a valid range on replay.
    ///
    /// # Emit order (order matters — each step depends on the previous)
    ///
    /// 1. **Buffer first.** `?1049h` enters the alt screen *and* clears it,
    ///    so no extra erase is needed when entering alt.  For main we emit
    ///    `?1049l\e[H\e[2J` to restore the main buffer and then clear it —
    ///    `?1049l` only restores the saved cursor, it does not wipe content.
    ///
    /// 2. **Scroll region** after buffer toggle, because DECSTBM also homes
    ///    the cursor and is scoped to the current buffer (alt vs main).
    ///    We clamp to `[1, rows]` so stale values never create an invalid
    ///    range on a resized terminal.
    ///
    /// 3. **Auto-wrap + cursor visibility** — always emitted so the client
    ///    is never left in an unknown state for these two critical modes.
    ///
    /// 4. **Optional flags** — only emitted when `true` (their default is
    ///    off, so omitting them is equivalent to clearing them).
    ///
    /// 5. **Mouse modes** — only emitted when non-zero.
    pub fn emit(&self, rows: u16) -> String {
        let mut out = String::new();

        // Step 1 — Buffer selection.
        if self.modes.alt_screen {
            // ?1049h: save main-buffer cursor, clear alt buffer, switch to alt.
            out.push_str("\x1b[?1049h");
        } else {
            // ?1049l: switch back to main buffer and restore its cursor.
            // \e[H\e[2J: home + erase the main buffer (restore doesn't clear).
            out.push_str("\x1b[?1049l\x1b[H\x1b[2J");
        }

        // Step 2 — Scroll region.
        if let (Some(top), Some(bot)) = (self.modes.stbm_top, self.modes.stbm_bottom) {
            // Clamp to [1, rows] and ensure top <= bottom.
            let top_clamped = top.max(1).min(rows);
            let bot_clamped = bot.max(top_clamped).min(rows);
            out.push_str(&format!("\x1b[{};{}r", top_clamped, bot_clamped));
        } else {
            // Reset to full-screen scroll region.
            out.push_str("\x1b[r");
        }

        // Step 3 — Auto-wrap and cursor visibility (always emitted).
        if self.modes.auto_wrap {
            out.push_str("\x1b[?7h");
        } else {
            out.push_str("\x1b[?7l");
        }
        if self.modes.cursor_visible {
            out.push_str("\x1b[?25h");
        } else {
            out.push_str("\x1b[?25l");
        }

        // Step 4 — Optional flags (only emitted when enabled).
        if self.modes.bracketed_paste {
            out.push_str("\x1b[?2004h");
        }
        if self.modes.focus_reporting {
            out.push_str("\x1b[?1004h");
        }
        if self.modes.in_band_resize {
            out.push_str("\x1b[?2031h");
        }

        // Step 5 — Mouse modes (only emitted when non-zero).
        if self.modes.mouse_mode != 0 {
            out.push_str(&format!("\x1b[?{}h", self.modes.mouse_mode));
        }
        if self.modes.mouse_ext != 0 {
            out.push_str(&format!("\x1b[?{}h", self.modes.mouse_ext));
        }

        out
    }
}

impl Default for ModeScanner {
    fn default() -> Self {
        Self::new()
    }
}
