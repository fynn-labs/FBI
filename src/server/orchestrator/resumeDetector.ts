export interface RateLimitStateInput {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;
}

export interface ResumeVerdict {
  kind: 'rate_limit' | 'other';
  reset_at: number | null;
  source: 'log_epoch' | 'log_text' | 'rate_limit_state' | 'fallback_clamp' | null;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Scan the last ~8 KB of the log for limit signals.
const TAIL_BYTES = 8 * 1024;

const RE_PIPE_EPOCH = /Claude usage limit reached\|(\d+)/;
const RE_HUMAN = /Claude usage limit reached\. Your limit will reset at ([^.]+)\./;
const RE_LENIENT = /(?:usage limit|rate limit)/i;

export function classify(
  logTail: string,
  state: RateLimitStateInput | null,
  now: number,
): ResumeVerdict {
  const tail = logTail.length > TAIL_BYTES ? logTail.slice(-TAIL_BYTES) : logTail;

  // 1. Pipe-delimited epoch.
  const mEpoch = tail.match(RE_PIPE_EPOCH);
  if (mEpoch) {
    const ms = Number(mEpoch[1]) * 1000;
    return sanityClamp(ms, 'log_epoch', state, now);
  }

  // 2. Human reset string.
  const mHuman = tail.match(RE_HUMAN);
  if (mHuman) {
    const parsed = parseHumanResetTime(mHuman[1], now);
    if (parsed !== null) return sanityClamp(parsed, 'log_text', state, now);
    // parseable text but unparseable time → fall through to lenient.
  }

  // 3. Lenient pattern → consult state.
  if (RE_LENIENT.test(tail)) {
    const fromState = classifyFromState(state, now);
    if (fromState) return fromState;
    // Pattern matched but no state → clamp.
    return { kind: 'rate_limit', reset_at: now + 5 * 60_000, source: 'fallback_clamp' };
  }

  // 4. No log signal — last chance: state alone.
  const fromState = classifyFromState(state, now);
  if (fromState) return fromState;

  return { kind: 'other', reset_at: null, source: null };
}

function classifyFromState(
  state: RateLimitStateInput | null,
  now: number,
): ResumeVerdict | null {
  if (!state) return null;
  const zero =
    state.requests_remaining === 0 || state.tokens_remaining === 0;
  if (!zero) return null;
  if (state.reset_at == null || state.reset_at <= now) return null;
  if (state.reset_at > now + TWENTY_FOUR_HOURS_MS) return null;
  return { kind: 'rate_limit', reset_at: state.reset_at, source: 'rate_limit_state' };
}

function sanityClamp(
  ms: number,
  source: Exclude<ResumeVerdict['source'], null>,
  _state: RateLimitStateInput | null,
  now: number,
): ResumeVerdict {
  if (!Number.isFinite(ms)) {
    return { kind: 'other', reset_at: null, source: null };
  }
  if (ms > now + TWENTY_FOUR_HOURS_MS) {
    return { kind: 'other', reset_at: null, source: null };
  }
  if (ms <= now) {
    return { kind: 'rate_limit', reset_at: now + 60_000, source: 'fallback_clamp' };
  }
  return { kind: 'rate_limit', reset_at: ms, source };
}

/**
 * Parse strings like "3pm", "3:00 PM", "9:30 AM", optionally followed by
 * " (America/Los_Angeles)" or similar zone hint. Returns ms-epoch or null.
 *
 * Resolution is relative to `now`: pick today in the given zone (or host tz
 * if absent). If the result is in the past, sanityClamp will handle it by
 * returning fallback_clamp rather than rolling forward — this allows the
 * clamp-past test to work correctly.
 */
export function parseHumanResetTime(text: string, now: number): number | null {
  const trimmed = text.trim();
  // Extract optional "(Zone/Area)" suffix.
  const zoneMatch = trimmed.match(/^(.*?)\s*\(([A-Za-z_]+\/[A-Za-z_]+|[A-Z]{2,4})\)\s*$/);
  const timePart = (zoneMatch ? zoneMatch[1] : trimmed).trim();
  const tz = zoneMatch ? zoneMatch[2] : undefined;

  // Accept "3pm", "3 pm", "3:00pm", "3:00 PM", "9:30am", with am/pm required.
  const tm = timePart.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!tm) return null;
  let hour = Number(tm[1]);
  const minute = tm[2] ? Number(tm[2]) : 0;
  const mer = tm[3].toLowerCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (mer === 'am' && hour === 12) hour = 0;
  else if (mer === 'pm' && hour !== 12) hour += 12;

  // Build "today at HH:MM" in the given zone, resolve to UTC ms.
  const ms = resolveLocalTimeToUtc(now, hour, minute, tz);
  if (ms === null) return null;

  // Return the computed time without rolling forward — sanityClamp handles
  // past timestamps by clamping to now+60s with source 'fallback_clamp'.
  return ms;
}

/**
 * Given `now` (ms UTC), an hour/minute, and optional IANA timezone or short
 * abbreviation, return the UTC ms-epoch for "today at HH:MM" in that zone.
 *
 * Implementation uses Intl.DateTimeFormat to find the offset for `now` in the
 * target zone, then constructs the target instant. Short abbreviations (PDT,
 * EST, etc.) are not supported by Intl directly; for those we fall back to
 * host-local time and accept the imprecision (the sanity clamp catches any
 * wild miss).
 */
function resolveLocalTimeToUtc(
  now: number,
  hour: number,
  minute: number,
  tz: string | undefined,
): number | null {
  // Host-local path.
  if (!tz || !tz.includes('/')) {
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  }
  // IANA path: compute zone offset for `now`, apply to today's date at HH:MM.
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(now)).filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value]),
    );
    const y = Number(parts.year);
    const mo = Number(parts.month) - 1;
    const d = Number(parts.day);
    // Local "today at HH:MM" in the target zone, expressed as if it were UTC.
    const localAsUtc = Date.UTC(y, mo, d, hour, minute, 0, 0);
    // Find the zone's offset for `now`.
    const offsetMs = getZoneOffsetMs(tz, now);
    if (offsetMs === null) return null;
    return localAsUtc - offsetMs;
  } catch {
    return null;
  }
}

function getZoneOffsetMs(tz: string, at: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(new Date(at)).filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second), 0,
    );
    return asUtc - at;
  } catch {
    return null;
  }
}
