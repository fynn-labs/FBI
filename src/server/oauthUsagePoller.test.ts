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
  it('nudge within 60s of last poll is suppressed', async () => {
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
    nowMs += 30_000;
    await poller.nudge();
    expect(fetchSpy.mock.calls.length).toBe(before);          // suppressed
    nowMs += 35_000; // >60s after the original poll
    await poller.nudge();
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(before);
  });
});
