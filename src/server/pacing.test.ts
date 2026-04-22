import { describe, it, expect } from 'vitest';
import { derivePacing, KNOWN_BUCKET_WINDOWS } from './pacing.js';
import type { UsageBucket } from '../shared/types.js';

const hr = 3600 * 1000;

describe('derivePacing', () => {
  it('on_track when utilization roughly matches elapsed fraction', () => {
    const now = 5 * hr;
    const b: UsageBucket = { id: 'five_hour', utilization: 0.40, reset_at: 8 * hr, window_started_at: 3 * hr };
    // elapsed = 2h / 5h = 0.4 → delta 0 → on_track
    const p = derivePacing(b, now);
    expect(p.zone).toBe('on_track');
    expect(Math.abs(p.delta)).toBeLessThan(0.01);
  });

  it('hot when utilization >=10pp above expected', () => {
    const now = 5 * hr;
    const b: UsageBucket = { id: 'five_hour', utilization: 0.60, reset_at: 8 * hr, window_started_at: 3 * hr };
    // elapsed 0.4; utilization 0.6 → +20pp
    const p = derivePacing(b, now);
    expect(p.zone).toBe('hot');
    expect(p.delta).toBeCloseTo(0.20, 2);
  });

  it('chill when utilization >=5pp below expected', () => {
    const now = 5 * hr;
    const b: UsageBucket = { id: 'five_hour', utilization: 0.30, reset_at: 7 * hr, window_started_at: 2 * hr };
    // elapsed 3h / 5h = 0.6; utilization 0.3 → -30pp
    expect(derivePacing(b, now).zone).toBe('chill');
  });

  it('none when inside first 5% of window', () => {
    const now = 5 * hr;
    const b: UsageBucket = { id: 'five_hour', utilization: 0.05, reset_at: 10 * hr, window_started_at: (5 * hr) - (0.1 * hr) };
    expect(derivePacing(b, now).zone).toBe('none');
  });

  it('derives window_started_at for known bucket when null', () => {
    const now = 5 * hr;
    const b: UsageBucket = { id: 'five_hour', utilization: 0.40, reset_at: 8 * hr, window_started_at: null };
    // Derived: 8h - 5h = 3h; elapsed 2h / 5h = 0.4 → on_track
    expect(derivePacing(b, now).zone).toBe('on_track');
  });

  it('none for unknown bucket with no window_started_at', () => {
    const b: UsageBucket = { id: 'mystery', utilization: 0.9, reset_at: 10 * hr, window_started_at: null };
    expect(derivePacing(b, 5 * hr).zone).toBe('none');
  });

  it('KNOWN_BUCKET_WINDOWS has the three documented buckets', () => {
    expect(KNOWN_BUCKET_WINDOWS.five_hour).toBe(5 * hr);
    expect(KNOWN_BUCKET_WINDOWS.weekly).toBe(7 * 24 * hr);
    expect(KNOWN_BUCKET_WINDOWS.sonnet_weekly).toBe(7 * 24 * hr);
  });
});
