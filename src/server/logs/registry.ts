import { Broadcaster } from './broadcaster.js';
import { StateBroadcaster } from './stateBroadcaster.js';

export class RunStreamRegistry {
  private bytes = new Map<number, Broadcaster>();
  private state = new Map<number, StateBroadcaster>();

  getOrCreate(runId: number): Broadcaster {
    let b = this.bytes.get(runId);
    if (!b) {
      b = new Broadcaster();
      this.bytes.set(runId, b);
    }
    return b;
  }

  get(runId: number): Broadcaster | undefined {
    return this.bytes.get(runId);
  }

  getOrCreateState(runId: number): StateBroadcaster {
    let b = this.state.get(runId);
    if (!b) {
      b = new StateBroadcaster();
      this.state.set(runId, b);
    }
    return b;
  }

  getState(runId: number): StateBroadcaster | undefined {
    return this.state.get(runId);
  }

  release(runId: number): void {
    this.bytes.delete(runId);
    this.state.delete(runId);
  }
}
