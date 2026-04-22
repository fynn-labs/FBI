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
});
