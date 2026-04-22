import { describe, it, expect } from 'vitest';
import { RunStreamRegistry } from './registry.js';

describe('RunStreamRegistry', () => {
  it('creates one broadcaster per run id, reuses on second get', () => {
    const r = new RunStreamRegistry();
    const a = r.getOrCreate(1);
    const b = r.getOrCreate(1);
    expect(a).toBe(b);
  });

  it('release removes it after end', () => {
    const r = new RunStreamRegistry();
    const bc = r.getOrCreate(7);
    bc.end();
    r.release(7);
    const fresh = r.getOrCreate(7);
    expect(fresh).not.toBe(bc);
  });

  it('getOrCreateState reuses the same broadcaster for the same run id', () => {
    const r = new RunStreamRegistry();
    const a = r.getOrCreateState(5);
    const b = r.getOrCreateState(5);
    expect(a).toBe(b);
  });

  it('getState returns undefined after release', () => {
    const r = new RunStreamRegistry();
    r.getOrCreateState(8);
    r.release(8);
    expect(r.getState(8)).toBeUndefined();
  });
});
