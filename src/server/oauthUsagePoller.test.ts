import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb, type DB } from './db/index.js';
import { RateLimitStateRepo } from './db/rateLimitState.js';
import { RateLimitBucketsRepo } from './db/rateLimitBuckets.js';
import { OAuthUsagePoller } from './oauthUsagePoller.js';
import type { UsageWsMessage } from '../shared/types.js';

function mockFetch(responses: Array<Response | Error>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

describe('OAuthUsagePoller', () => {
  let db: DB;
  let state: RateLimitStateRepo;
  let buckets: RateLimitBucketsRepo;
  beforeEach(() => { db = openDb(':memory:'); state = new RateLimitStateRepo(db); buckets = new RateLimitBucketsRepo(db); });

  it('poll() writes buckets and sets observed_at on success', async () => {
    const now = 1_700_000_000_000;
    const fetchMock = mockFetch([
      jsonResponse({ plan: 'max' }),
      jsonResponse({ buckets: [
        { id: 'five_hour', utilization: 42, resets_at: now + 2 * 3600_000 },
        { id: 'weekly',    utilization: 18, resets_at: now + 6 * 24 * 3600_000 },
      ]}),
    ]);
    const events: UsageWsMessage[] = [];
    const poller = new OAuthUsagePoller({
      fetch: fetchMock, readToken: () => 'token-abc', state, buckets, now: () => now, onEvent: (e) => events.push(e),
    });
    await poller.pollOnce();
    expect(buckets.list()).toHaveLength(2);
    expect(state.get().observed_at).toBe(now);
    expect(state.get().plan).toBe('max');
    expect(events.at(-1)).toMatchObject({ type: 'snapshot' });
  });

  it('missing token → last_error = "missing_credentials", no bucket writes', async () => {
    const poller = new OAuthUsagePoller({
      fetch: mockFetch([]), readToken: () => null, state, buckets, now: () => 1, onEvent: () => {},
    });
    await poller.pollOnce();
    expect(state.get().last_error).toBe('missing_credentials');
    expect(buckets.list()).toHaveLength(0);
  });

  it('401 → last_error = "expired"', async () => {
    const poller = new OAuthUsagePoller({
      fetch: mockFetch([jsonResponse({}, { status: 401 })]),
      readToken: () => 'tok', state, buckets, now: () => 1, onEvent: () => {},
    });
    await poller.pollOnce();
    expect(state.get().last_error).toBe('expired');
  });

  it('429 → last_error = "rate_limited", buckets preserved', async () => {
    buckets.upsert({ bucket_id: 'five_hour', utilization: 0.5, reset_at: 100, window_started_at: 0, observed_at: 0 });
    const poller = new OAuthUsagePoller({
      fetch: mockFetch([jsonResponse({}, { status: 429 })]),
      readToken: () => 'tok', state, buckets, now: () => 1, onEvent: () => {},
    });
    await poller.pollOnce();
    expect(state.get().last_error).toBe('rate_limited');
    expect(buckets.list()).toHaveLength(1);
  });

  it('network error → last_error = "network"', async () => {
    const poller = new OAuthUsagePoller({
      fetch: mockFetch([new Error('ECONNREFUSED')]),
      readToken: () => 'tok', state, buckets, now: () => 1, onEvent: () => {},
    });
    await poller.pollOnce();
    expect(state.get().last_error).toBe('network');
  });

  it('profile is fetched only once across polls', async () => {
    const now = 1_700_000_000_000;
    const profile = vi.fn(() => jsonResponse({ plan: 'max' }));
    const usage = vi.fn(() => jsonResponse({ buckets: [{ id: 'five_hour', utilization: 0, resets_at: now }]}));
    const fetchMock = (async (url: string) => {
      if (String(url).endsWith('/profile')) return profile();
      return usage();
    }) as unknown as typeof fetch;
    const poller = new OAuthUsagePoller({
      fetch: fetchMock, readToken: () => 'tok', state, buckets, now: () => now, onEvent: () => {},
    });
    await poller.pollOnce();
    await poller.pollOnce();
    expect(profile).toHaveBeenCalledTimes(1);
  });

  it('schema-driven: unknown bucket id is written', async () => {
    const now = 1;
    const fetchMock = mockFetch([
      jsonResponse({ plan: 'pro' }),
      jsonResponse({ buckets: [{ id: 'daily', utilization: 10, resets_at: 100 }]}),
    ]);
    const poller = new OAuthUsagePoller({
      fetch: fetchMock, readToken: () => 'tok', state, buckets, now: () => now, onEvent: () => {},
    });
    await poller.pollOnce();
    expect(buckets.list()[0].bucket_id).toBe('daily');
  });

  it('live API shape: object keyed by bucket name → normalized + aliased', async () => {
    // This is the real shape returned by https://api.anthropic.com/api/oauth/usage
    // (no top-level "buckets" array). Per-bucket keys: utilization + resets_at.
    // seven_day → weekly, seven_day_sonnet → sonnet_weekly. Null values and
    // `extra_usage` (different shape) must be skipped, as must buckets with
    // resets_at: null (inactive/promotional buckets like seven_day_omelette).
    const now = 1_700_000_000_000;
    const resetFive = new Date(now + 2 * 3600_000).toISOString();
    const resetWeek = new Date(now + 6 * 24 * 3600_000).toISOString();
    const fetchMock = mockFetch([
      jsonResponse({
        account: { has_claude_max: true },
        organization: { organization_type: 'claude_max', billing_type: 'stripe_subscription' },
      }),
      jsonResponse({
        five_hour: { utilization: 8.0, resets_at: resetFive },
        seven_day: { utilization: 41.0, resets_at: resetWeek },
        seven_day_sonnet: { utilization: 20.0, resets_at: resetWeek },
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_cowork: null,
        seven_day_omelette: { utilization: 0.0, resets_at: null },
        iguana_necktie: null,
        omelette_promotional: null,
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
      }),
    ]);
    const poller = new OAuthUsagePoller({
      fetch: fetchMock, readToken: () => 'tok', state, buckets,
      now: () => now, onEvent: () => {},
    });
    await poller.pollOnce();
    const ids = buckets.list().map(b => b.bucket_id).sort();
    expect(ids).toEqual(['five_hour', 'sonnet_weekly', 'weekly']);
    expect(state.get().plan).toBe('max');
    const five = buckets.list().find(b => b.bucket_id === 'five_hour')!;
    expect(five.utilization).toBeCloseTo(0.08, 5);
    expect(five.reset_at).toBe(Date.parse(resetFive));
    // window_started_at derived from KNOWN_BUCKET_WINDOWS when absent.
    expect(five.window_started_at).toBe(Date.parse(resetFive) - 5 * 3600_000);
  });

  it('live profile shape: has_claude_pro → plan=pro', async () => {
    const fetchMock = mockFetch([
      jsonResponse({ account: { has_claude_pro: true, has_claude_max: false } }),
      jsonResponse({ five_hour: { utilization: 0, resets_at: new Date(Date.now() + 3600_000).toISOString() } }),
    ]);
    const poller = new OAuthUsagePoller({
      fetch: fetchMock, readToken: () => 'tok', state, buckets, now: () => 1, onEvent: () => {},
    });
    await poller.pollOnce();
    expect(state.get().plan).toBe('pro');
  });

  it('bucket that disappears on next poll is deleted', async () => {
    const now = 1;
    const fetchMock = mockFetch([
      jsonResponse({ plan: 'pro' }),
      jsonResponse({ buckets: [{ id: 'five_hour', utilization: 10, resets_at: 100 }, { id: 'weekly', utilization: 5, resets_at: 200 }]}),
      jsonResponse({ buckets: [{ id: 'five_hour', utilization: 20, resets_at: 100 }]}),
    ]);
    const poller = new OAuthUsagePoller({
      fetch: fetchMock, readToken: () => 'tok', state, buckets, now: () => now, onEvent: () => {},
    });
    await poller.pollOnce();
    await poller.pollOnce();
    const ids = buckets.list().map(b => b.bucket_id);
    expect(ids).toEqual(['five_hour']);
  });
});

describe('OAuthUsagePoller threshold_crossed events', () => {
  it('emits once per bucket per window', async () => {
    const db = openDb(':memory:');
    const state = new RateLimitStateRepo(db);
    const buckets = new RateLimitBucketsRepo(db);
    let util = 0.7;
    let resetAt = 100_000;
    const fetchMock = (async (url: string) => {
      if (String(url).endsWith('/profile')) return jsonResponse({ plan: 'max' });
      return jsonResponse({ buckets: [{ id: 'five_hour', utilization: util * 100, resets_at: resetAt }]});
    }) as unknown as typeof fetch;
    const events: UsageWsMessage[] = [];
    const poller = new OAuthUsagePoller({
      fetch: fetchMock, readToken: () => 'tok', state, buckets,
      now: () => 1, onEvent: (e) => events.push(e),
    });
    await poller.pollOnce();
    expect(events.filter(e => e.type === 'threshold_crossed')).toHaveLength(0);
    util = 0.80;
    await poller.pollOnce();
    expect(events.filter(e => e.type === 'threshold_crossed' && e.threshold === 75)).toHaveLength(1);
    util = 0.92;
    await poller.pollOnce();
    expect(events.filter(e => e.type === 'threshold_crossed' && e.threshold === 90)).toHaveLength(1);
    // Next poll at 92% must NOT emit again.
    await poller.pollOnce();
    expect(events.filter(e => e.type === 'threshold_crossed')).toHaveLength(2);
    // Window rolls → allowed to re-notify.
    resetAt = 200_000;
    await poller.pollOnce();
    util = 0.91;
    await poller.pollOnce();
    expect(events.filter(e => e.type === 'threshold_crossed').length).toBeGreaterThan(2);
  });
});

describe('OAuthUsagePoller cadence', () => {
  it('nudge within 5 min of last poll is suppressed, allowed after', async () => {
    const db = openDb(':memory:');
    const state = new RateLimitStateRepo(db);
    const buckets = new RateLimitBucketsRepo(db);
    let nowMs = 1_700_000_000_000;
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).endsWith('/profile')) return jsonResponse({ plan: 'max' });
      return jsonResponse({ buckets: [{ id: 'five_hour', utilization: 10, resets_at: nowMs + 3600_000 }] });
    });
    const poller = new OAuthUsagePoller({
      fetch: fetchSpy as unknown as typeof fetch,
      readToken: () => 'tok', state, buckets,
      now: () => nowMs, onEvent: () => {},
    });
    await poller.pollOnce();
    const before = fetchSpy.mock.calls.length;
    nowMs += 60_000;
    await poller.nudge();
    expect(fetchSpy.mock.calls.length).toBe(before);          // still suppressed at 1 min
    nowMs += 4 * 60_000 + 1000; // >5 min total since last poll
    await poller.nudge();
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it('nudge is gated by last attempt, not last success (errors still cost a poll)', async () => {
    const db = openDb(':memory:');
    const state = new RateLimitStateRepo(db);
    const buckets = new RateLimitBucketsRepo(db);
    let nowMs = 1_700_000_000_000;
    // First call errors (429), subsequent nudge within 5 min must be suppressed
    // even though observed_at was never set.
    let callCount = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      callCount += 1;
      if (String(url).endsWith('/profile')) return jsonResponse({}, { status: 500 });
      return jsonResponse({}, { status: 429 });
    });
    const poller = new OAuthUsagePoller({
      fetch: fetchSpy as unknown as typeof fetch,
      readToken: () => 'tok', state, buckets,
      now: () => nowMs, onEvent: () => {},
    });
    await poller.pollOnce();
    expect(callCount).toBeGreaterThan(0);
    const before = callCount;
    nowMs += 30_000;
    await poller.nudge();
    expect(callCount).toBe(before); // suppressed — last_error_at gates nudges too
  });

  it('start() defers the first poll when observed_at is still fresh across a restart', async () => {
    vi.useFakeTimers();
    try {
      const db = openDb(':memory:');
      const state = new RateLimitStateRepo(db);
      const buckets = new RateLimitBucketsRepo(db);
      const nowMs = 1_700_000_000_000;
      // Simulate a previous process that successfully polled 1 minute ago.
      state.setObserved(nowMs - 60_000);
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).endsWith('/profile')) return jsonResponse({ plan: 'max' });
        return jsonResponse({ buckets: [{ id: 'five_hour', utilization: 10, resets_at: nowMs + 3600_000 }] });
      });
      const poller = new OAuthUsagePoller({
        fetch: fetchSpy as unknown as typeof fetch,
        readToken: () => 'tok', state, buckets,
        now: () => nowMs, onEvent: () => {},
      });
      poller.start();
      // Run any immediately-queued timers; a naive start() would fire pollOnce now.
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchSpy).not.toHaveBeenCalled();
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() polls immediately when observed_at is stale', async () => {
    vi.useFakeTimers();
    try {
      const db = openDb(':memory:');
      const state = new RateLimitStateRepo(db);
      const buckets = new RateLimitBucketsRepo(db);
      const nowMs = 1_700_000_000_000;
      // Previous success was 10 minutes ago (>intervalMs).
      state.setObserved(nowMs - 10 * 60_000);
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).endsWith('/profile')) return jsonResponse({ plan: 'max' });
        return jsonResponse({ buckets: [{ id: 'five_hour', utilization: 10, resets_at: nowMs + 3600_000 }] });
      });
      const poller = new OAuthUsagePoller({
        fetch: fetchSpy as unknown as typeof fetch,
        readToken: () => 'tok', state, buckets,
        now: () => nowMs, onEvent: () => {},
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
