import type { RunWsStateMessage } from '../../shared/types.js';

export type StateFrame = RunWsStateMessage;
type Listener = (frame: StateFrame) => void;

export class StateBroadcaster {
  private subs = new Set<Listener>();
  private last: StateFrame | null = null;

  publish(frame: StateFrame): void {
    this.last = frame;
    for (const s of this.subs) s(frame);
  }

  subscribe(listener: Listener): () => void {
    this.subs.add(listener);
    if (this.last) listener(this.last);
    return () => { this.subs.delete(listener); };
  }
}
