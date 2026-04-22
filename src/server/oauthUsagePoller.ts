import type { RateLimitStateRepo } from './db/rateLimitState.js';
import type { RateLimitBucketsRepo } from './db/rateLimitBuckets.js';
import type { UsageBucket, UsageState, UsageWsMessage, PacingVerdict } from '../shared/types.js';
import { derivePacing, KNOWN_BUCKET_WINDOWS } from './pacing.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const BETA_HEADER = 'oauth-2025-04-20';

export interface OAuthUsagePollerOptions {
  fetch: typeof fetch;
  readToken: () => string | null;
  state: RateLimitStateRepo;
  buckets: RateLimitBucketsRepo;
  now?: () => number;
  onEvent: (m: UsageWsMessage) => void;
}

interface RawBucket {
  id?: unknown;
  utilization?: unknown;
  resets_at?: unknown;
  window_started_at?: unknown;
}

export class OAuthUsagePoller {
  private opts: Required<OAuthUsagePollerOptions>;
  private planFetched = false;
  private timer: NodeJS.Timeout | null = null;
  private lastPollAt = 0;
  private readonly intervalMs = 5 * 60 * 1000;
  private readonly minNudgeGapMs = 60 * 1000;

  constructor(opts: OAuthUsagePollerOptions) {
    this.opts = { now: () => Date.now(), ...opts };
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.pollOnce();
      if (this.timer) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  async nudge(): Promise<void> {
    if (this.opts.now() - this.lastPollAt < this.minNudgeGapMs) return;
    await this.pollOnce();
  }

  async pollOnce(): Promise<void> {
    const token = this.opts.readToken();
    const now = this.opts.now();
    this.lastPollAt = now;
    if (!token) { this.markError('missing_credentials', now); return; }

    try {
      if (!this.planFetched) await this.fetchPlan(token);
      const res = await this.opts.fetch(USAGE_URL, {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': BETA_HEADER },
      });
      if (res.status === 401) { this.markError('expired', now); return; }
      if (res.status === 429) { this.markError('rate_limited', now); return; }
      if (!res.ok) { this.markError('network', now); return; }

      const body = await res.json() as { buckets?: RawBucket[] };
      const normalized = this.normalize(body.buckets ?? []);
      this.opts.buckets.replaceAll(normalized.map(b => ({
        bucket_id: b.id,
        utilization: b.utilization,
        reset_at: b.reset_at,
        window_started_at: b.window_started_at,
        observed_at: now,
      })));
      this.opts.buckets.clearNotifiedIfReset();

      // Threshold-cross detection.
      for (const b of this.opts.buckets.list()) {
        const crossed: (75 | 90)[] = [];
        if (b.utilization >= 0.90 && (b.last_notified_threshold ?? 0) < 90) crossed.push(90);
        else if (b.utilization >= 0.75 && (b.last_notified_threshold ?? 0) < 75) crossed.push(75);
        for (const t of crossed) {
          this.opts.buckets.markNotified(b.bucket_id, t, b.reset_at);
          this.opts.onEvent({
            type: 'threshold_crossed',
            bucket_id: b.bucket_id,
            threshold: t,
            reset_at: b.reset_at,
          });
        }
      }

      this.opts.state.setObserved(now);

      this.opts.onEvent({ type: 'snapshot', state: this.snapshot(now) });
    } catch {
      this.markError('network', now);
    }
  }

  snapshot(now?: number): UsageState {
    const t = now ?? this.opts.now();
    const st = this.opts.state.get();
    const bs = this.opts.buckets.list();
    const buckets: UsageBucket[] = bs.map(b => ({
      id: b.bucket_id,
      utilization: b.utilization,
      reset_at: b.reset_at,
      window_started_at: b.window_started_at,
    }));
    const pacing: Record<string, PacingVerdict> = {};
    for (const b of buckets) pacing[b.id] = derivePacing(b, t);
    return {
      plan: st.plan,
      observed_at: st.observed_at,
      last_error: st.last_error,
      last_error_at: st.last_error_at,
      buckets,
      pacing,
    };
  }

  private async fetchPlan(token: string): Promise<void> {
    try {
      const res = await this.opts.fetch(PROFILE_URL, {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': BETA_HEADER },
      });
      if (res.ok) {
        const body = await res.json() as { plan?: unknown };
        if (body.plan === 'pro' || body.plan === 'max' || body.plan === 'team') {
          this.opts.state.setPlan(body.plan);
        }
      }
    } catch { /* plan is optional */ }
    this.planFetched = true;
  }

  private markError(kind: Exclude<UsageState['last_error'], null>, now: number): void {
    this.opts.state.setError(kind, now);
    this.opts.onEvent({ type: 'snapshot', state: this.snapshot(now) });
  }

  private normalize(raw: RawBucket[]): UsageBucket[] {
    const out: UsageBucket[] = [];
    for (const r of raw) {
      if (typeof r.id !== 'string') continue;
      const u = typeof r.utilization === 'number' ? r.utilization : Number(r.utilization);
      if (!Number.isFinite(u)) continue;
      const resetAt = toMsEpoch(r.resets_at);
      const winStart = toMsEpoch(r.window_started_at);
      out.push({
        id: r.id,
        utilization: Math.max(0, Math.min(1, u / 100)),
        reset_at: resetAt,
        window_started_at: winStart ?? (resetAt != null && KNOWN_BUCKET_WINDOWS[r.id] != null ? resetAt - KNOWN_BUCKET_WINDOWS[r.id] : null),
      });
    }
    return out;
  }
}

function toMsEpoch(v: unknown): number | null {
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  return null;
}
