import { describe, it, expect } from 'vitest';
import { Broadcaster } from './broadcaster.js';

describe('Broadcaster', () => {
  it('fans out bytes to all subscribers', () => {
    const b = new Broadcaster();
    const a: string[] = [];
    const c: string[] = [];
    const unsubA = b.subscribe((chunk) => a.push(Buffer.from(chunk).toString()));
    const unsubC = b.subscribe((chunk) => c.push(Buffer.from(chunk).toString()));
    b.publish(Buffer.from('x'));
    b.publish(Buffer.from('y'));
    expect(a).toEqual(['x', 'y']);
    expect(c).toEqual(['x', 'y']);
    unsubA();
    b.publish(Buffer.from('z'));
    expect(a).toEqual(['x', 'y']);
    expect(c).toEqual(['x', 'y', 'z']);
    unsubC();
  });

  it('end() signals subscribers and ignores post-end publishes', () => {
    const b = new Broadcaster();
    const events: Array<string | 'end'> = [];
    b.subscribe(
      (chunk) => events.push(Buffer.from(chunk).toString()),
      () => events.push('end')
    );
    b.publish(Buffer.from('a'));
    b.end();
    b.publish(Buffer.from('ignored'));
    expect(events).toEqual(['a', 'end']);
  });
});
