import { describe, it, expect } from 'vitest';
import { TypedBroadcaster } from './typedBroadcaster.js';

describe('TypedBroadcaster', () => {
  it('fans out typed messages to subscribers and respects unsubscribe + end', () => {
    const b = new TypedBroadcaster<{ n: number }>();
    const got: number[] = [];
    const unsub = b.subscribe((m) => got.push(m.n));
    b.publish({ n: 1 });
    b.publish({ n: 2 });
    unsub();
    b.publish({ n: 3 });
    expect(got).toEqual([1, 2]);
    const endMarker: string[] = [];
    b.subscribe(() => {}, () => endMarker.push('end'));
    b.end();
    b.publish({ n: 99 });
    expect(endMarker).toEqual(['end']);
  });
});
