import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './resumeDetector.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  fs.readFileSync(path.join(HERE, '__fixtures__/resume-detector', name), 'utf8');

// Fixed "now" used where tests don't care: 2026-04-22T12:00:00Z
const NOW = Date.UTC(2026, 3, 22, 12, 0, 0);

describe('resumeDetector.classify', () => {
  it('parses the pipe-epoch form', () => {
    const v = classify(fx('pipe-epoch.log'), null, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('log_epoch');
    expect(v.reset_at).toBe(1776870000 * 1000);
  });

  it('parses the human reset form with zone', () => {
    // Choose a "now" that puts "3pm America/Los_Angeles" in the future:
    // 2026-04-22T00:00:00 PDT  →  07:00 UTC.
    const now = Date.UTC(2026, 3, 22, 8, 0, 0);
    const v = classify(fx('human-3pm.log'), null, now);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('log_text');
    // 3pm PDT (UTC-7) on 2026-04-22 = 22:00 UTC
    expect(v.reset_at).toBe(Date.UTC(2026, 3, 22, 22, 0, 0));
  });

  it('parses the human reset form without zone (uses host tz)', () => {
    const v = classify(fx('human-no-zone.log'), null, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('log_text');
    expect(typeof v.reset_at).toBe('number');
  });

  it('lenient fallback produces rate_limit with state backfill', () => {
    const state = {
      requests_remaining: 0, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: NOW + 60 * 60 * 1000,
    };
    const v = classify(fx('reworded-lenient.log'), state, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('rate_limit_state');
    expect(v.reset_at).toBe(state.reset_at);
  });

  it('unrelated exit with no state produces "other"', () => {
    const v = classify(fx('unrelated-exit.log'), null, NOW);
    expect(v.kind).toBe('other');
    expect(v.reset_at).toBeNull();
  });

  it('log silent but state indicates zero-remaining → rate_limit from state', () => {
    const state = {
      requests_remaining: 0, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: NOW + 30 * 60 * 1000,
    };
    const v = classify(fx('state-only.log'), state, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('rate_limit_state');
  });

  it('past parsed time clamps to now+60s', () => {
    // "12:00 AM" on today's date is in the past when now=noon.
    const v = classify(fx('clamp-past.log'), null, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('fallback_clamp');
    expect(v.reset_at).toBe(NOW + 60_000);
  });

  it('parsed time >24h out is treated as parse failure', () => {
    const v = classify(fx('clamp-future.log'), null, NOW);
    expect(v.kind).toBe('other');
    expect(v.reset_at).toBeNull();
  });
});
