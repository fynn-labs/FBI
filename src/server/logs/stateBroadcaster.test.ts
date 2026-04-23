import { describe, it, expect } from 'vitest';
import { StateBroadcaster, type StateFrame } from './stateBroadcaster.js';

describe('StateBroadcaster', () => {
  it('delivers the latest frame to new subscribers', () => {
    const b = new StateBroadcaster();
    const f: StateFrame = {
      type: 'state', state: 'awaiting_resume', state_entered_at: Date.now(),
      next_resume_at: 1, resume_attempts: 1, last_limit_reset_at: 1,
    };
    b.publish(f);
    const received: StateFrame[] = [];
    b.subscribe((x) => received.push(x));
    expect(received).toEqual([f]);
  });

  it('broadcasts subsequent frames to all subscribers', () => {
    const b = new StateBroadcaster();
    const a: StateFrame[] = [];
    const c: StateFrame[] = [];
    b.subscribe((x) => a.push(x));
    b.subscribe((x) => c.push(x));
    const f: StateFrame = {
      type: 'state', state: 'running', state_entered_at: Date.now(),
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    };
    b.publish(f);
    expect(a).toEqual([f]);
    expect(c).toEqual([f]);
  });

  it('unsubscribe removes the listener', () => {
    const b = new StateBroadcaster();
    const received: StateFrame[] = [];
    const un = b.subscribe((x) => received.push(x));
    un();
    b.publish({
      type: 'state', state: 'running', state_entered_at: Date.now(),
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });
    expect(received).toEqual([]);
  });

  it('does not call listener on subscribe when no frame has been published', () => {
    const b = new StateBroadcaster();
    const received: StateFrame[] = [];
    b.subscribe((x) => received.push(x));
    expect(received).toEqual([]);
  });
});
