import { Broadcaster } from './broadcaster.js';
import { TypedBroadcaster } from './typedBroadcaster.js';
import type { RunWsUsageMessage, RunWsRateLimitMessage } from '../../shared/types.js';

export type RunEvent = RunWsUsageMessage | RunWsRateLimitMessage;

export class RunStreamRegistry {
  private bytes = new Map<number, Broadcaster>();
  private events = new Map<number, TypedBroadcaster<RunEvent>>();

  getOrCreate(runId: number): Broadcaster {
    let b = this.bytes.get(runId);
    if (!b) { b = new Broadcaster(); this.bytes.set(runId, b); }
    return b;
  }

  get(runId: number): Broadcaster | undefined {
    return this.bytes.get(runId);
  }

  getOrCreateEvents(runId: number): TypedBroadcaster<RunEvent> {
    let b = this.events.get(runId);
    if (!b) { b = new TypedBroadcaster<RunEvent>(); this.events.set(runId, b); }
    return b;
  }

  release(runId: number): void {
    this.bytes.delete(runId);
    this.events.delete(runId);
  }
}
